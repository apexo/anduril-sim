import { createServer } from 'http';
import { open } from "fs/promises";
import path from 'path';
import { fileURLToPath } from 'url';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.map': 'application/json',
  '.hex': 'text/plain',
};
const PORT = 8000;
const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/dist";

const notFound = (res) => {
  res.writeHead(404);
  res.end("Not found");
}

const error = (res) => {
  res.writeHead(500);
  res.end("Internal error");
}

createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const file = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  if (!file.startsWith(ROOT + "/")) return notFound(res);

  try {
    await using fd = await open(file, "r");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "text/plain"
    });

    for await (const chunk of fd.createReadStream()) {
      res.write(chunk);
    }
    res.end();

  } catch (e) {
    if (e instanceof Error && e.code === "ENOENT") {
      notFound(res);
    } else {
      console.error(e);
      error(res);
    }
  }
}).listen(PORT, () => console.log(`anduril-sim @ http://localhost:${PORT}`));
