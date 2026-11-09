// Video Studio: trình soạn kịch bản + chạy pipeline ngay trên máy.
// Chạy trong thư mục dự án:  node studio.mjs   rồi mở http://127.0.0.1:3000
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const OUT = path.join(ROOT, "output");
const PORT = 3000;

if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.error("Hãy chạy file này trong thư mục dự án (nơi có package.json).");
  process.exit(1);
}

let job = { running: false, dir: "", log: "", code: null, proc: null };

// ---- Tự động khởi động server giọng đọc (omnivoice-server cổng 8880, adapter cổng 8123) ----
const SERVICES = [
  { key: "omnivoice", name: "omnivoice-server", url: "http://127.0.0.1:8880/health", needOk: true, cmd: "omnivoice-server --num-step 16" },
  { key: "adapter", name: "adapter", url: "http://127.0.0.1:8123/tts", needOk: false, cmd: "node adapter.mjs", file: "adapter.mjs" },
];
const svc = { omnivoice: false, adapter: false };
const kids = {};
let busy = false;

const alive = async (url, needOk) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return needOk ? r.ok : true; // adapter chỉ nhận POST nên GET trả 404 vẫn nghĩa là đang sống
  } catch { return false; }
};

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
  else p.kill("SIGTERM");
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    for (const s of SERVICES) {
      svc[s.key] = await alive(s.url, s.needOk);
      const k = kids[s.key];
      if (svc[s.key] || (k && k.exitCode === null)) continue; // đang chạy, hoặc đang khởi động
      if ((s.fails || 0) >= 3) continue; // lỗi nhiều lần: ngừng tự mở lại
      if (s.file && !fs.existsSync(path.join(ROOT, s.file))) {
        if (!s.warned) { console.error(`Thiếu ${s.file} trong thư mục dự án.`); s.warned = true; }
        continue;
      }
      console.log(`Khởi động ${s.name}...`);
      const p = spawn(s.cmd, [], { cwd: ROOT, shell: true, windowsHide: true });
      let tail = "";
      const keep = (b) => { tail = (tail + b).slice(-1200); };
      p.stdout.on("data", keep);
      p.stderr.on("data", keep);
      p.on("close", (c) => {
        s.fails = (s.fails || 0) + 1;
        console.error(`[${s.name}] đã dừng (mã ${c}).${s.fails >= 3 ? " Không tự mở lại nữa, hãy tự chạy lệnh: " + s.cmd : ""}\n${tail}`);
      });
      kids[s.key] = p;
    }
  } finally { busy = false; }
}

const stopAll = () => Object.values(kids).forEach(killTree);
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
refresh();
setInterval(refresh, 3000);


const slugify = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video";

const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

const readBody = async (req) => {
  let b = "";
  for await (const c of req) b += c;
  return b;
};

function serveFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "not found" });
  const size = fs.statSync(file).size;
  const type = { ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".html": "text/html; charset=utf-8" }[path.extname(file)] || "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    const start = m[1] ? parseInt(m[1]) : 0;
    const end = m[2] ? parseInt(m[2]) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && url.pathname === "/") return serveFile(req, res, path.join(here, "studio.html"));

  if (req.method === "GET" && url.pathname.startsWith("/output/")) {
    const f = path.resolve(ROOT, "." + decodeURIComponent(url.pathname));
    if (!f.startsWith(OUT + path.sep)) return json(res, 403, { error: "forbidden" });
    return serveFile(req, res, f);
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const video = !job.running && job.code === 0 && fs.existsSync(path.join(OUT, job.dir, "video.mp4"));
    return json(res, 200, { running: job.running, dir: job.dir, log: job.log, code: job.code, video, svc });
  }

  if (req.method === "POST" && url.pathname === "/api/render") {
    if (job.running) return json(res, 409, { error: "Đang có video khác được tạo." });
    if (!svc.omnivoice || !svc.adapter)
      return json(res, 409, { error: "Server giọng đọc chưa sẵn sàng (omnivoice-server mất khoảng 1–2 phút để khởi động). Hãy chờ trạng thái chuyển xanh rồi bấm lại." });
    try {
      const { script } = JSON.parse(await readBody(req));
      const dir = `${slugify(script?.metadata?.title || "")}-${stamp()}`;
      fs.mkdirSync(path.join(OUT, dir), { recursive: true });
      fs.writeFileSync(path.join(OUT, dir, "script.json"), JSON.stringify(script, null, 4), "utf8");
      job = { running: true, dir, log: `> Thư mục: output/${dir}\n`, code: null, proc: null };
      const p = spawn("npm", ["run", "pipeline", "--", `output/${dir}/script.json`], { cwd: ROOT, shell: true });
      job.proc = p;
      const add = (b) => { job.log = (job.log + b.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "")).slice(-100000); };
      p.stdout.on("data", add);
      p.stderr.on("data", add);
      p.on("close", (c) => { job.running = false; job.code = c; job.log += `\n> Kết thúc (mã ${c})\n`; });
      return json(res, 200, { dir });
    } catch (e) {
      return json(res, 400, { error: String(e.message) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    if (job.running && job.proc) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(job.proc.pid), "/T", "/F"]);
      else job.proc.kill("SIGTERM");
    }
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`Video Studio: http://127.0.0.1:${PORT}`));
