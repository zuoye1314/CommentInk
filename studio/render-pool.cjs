const { Worker } = require("node:worker_threads");
const path = require("node:path");
const { hash } = require("./parser.cjs");

class RenderPool {
  constructor({ timeoutMs = 1500 } = {}) { this.timeoutMs = timeoutMs; this.queue = []; this.cache = new Map(); this.cacheBytes = 0; this.sequence = 0; }
  render(type, value, options) {
    const key = hash(JSON.stringify([type, value, options]));
    if (this.disposed) return Promise.reject(new Error("渲染器已关闭"));
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.queue.length >= 64) return Promise.reject(new Error("渲染队列已满，请稍后重试"));
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.sequence, key, type, value, options, resolve, reject }); this.next(); });
  }
  next() {
    if (this.active || !this.queue.length || this.disposed) return;
    if (!this.worker) {
      const worker = this.worker = new Worker(path.join(__dirname, "render-worker.cjs"), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
      worker.on("message", (message) => {
        if (worker !== this.worker || message.id !== this.active?.id) return;
        const job = this.active;
        clearTimeout(this.timer); this.active = undefined;
        if (message.error) job.reject(new Error(message.error));
        else {
          const bytes = Buffer.byteLength(JSON.stringify(message.result));
          if (bytes <= 4 * 1024 * 1024) {
            while (this.cache.size && (this.cache.size >= 32 || this.cacheBytes + bytes > 8 * 1024 * 1024)) {
              const [key, result] = this.cache.entries().next().value;
              this.cacheBytes -= Buffer.byteLength(JSON.stringify(result)); this.cache.delete(key);
            }
            this.cache.set(job.key, message.result); this.cacheBytes += bytes;
          }
          job.resolve(message.result);
        }
        this.next();
      });
      worker.on("error", (error) => { if (worker === this.worker) this.fail(error); });
      worker.on("exit", (code) => { if (worker === this.worker) this.fail(new Error(`渲染进程退出 (${code})`)); });
    }
    this.active = this.queue.shift();
    this.timer = setTimeout(() => this.fail(new Error("公式渲染超时，已停止并保留源码")), this.timeoutMs);
    const { id, type, value, options } = this.active;
    this.worker.postMessage({ id, type, value, options });
  }
  fail(error) {
    clearTimeout(this.timer);
    const worker = this.worker; this.worker = undefined;
    if (worker) void worker.terminate();
    const job = this.active; this.active = undefined;
    job?.reject(error); this.next();
  }
  dispose() {
    this.disposed = true;
    this.fail(new Error("渲染器已关闭"));
    for (const job of this.queue.splice(0)) job.reject(new Error("渲染器已关闭"));
    this.cache.clear(); this.cacheBytes = 0;
  }
}
module.exports = { RenderPool };
