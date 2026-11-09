import http from "node:http";
import { spawn } from "node:child_process";

const UPSTREAM = "http://127.0.0.1:8880/v1/audio/speech";
const PORT = 8123;

function wavToMp3(wav) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0", "-f", "mp3", "-b:a", "192k", "pipe:1",
    ]);
    const chunks = [];
    let err = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err)),
    );
    ff.stdin.on("error", () => {});
    ff.stdin.end(wav);
  });
}

http
  .createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/tts") {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const c of req) body += c;
      const { text } = JSON.parse(body);

      const r = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
          model: "omnivoice",
          input: text,
          instructions: "female, young adult, moderate pitch",
          position_temperature: 0,
          class_temperature: 0,
        }),
      });
      if (!r.ok) throw new Error(`upstream ${r.status}: ${await r.text()}`);

      const mp3 = await wavToMp3(Buffer.from(await r.arrayBuffer()));
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(mp3);
    } catch (e) {
      console.error(e);
      res.writeHead(500).end(String(e.message));
    }
  })
  .listen(PORT, "127.0.0.1", () =>
    console.log(`Adapter chạy tại http://127.0.0.1:${PORT}/tts`),
  );