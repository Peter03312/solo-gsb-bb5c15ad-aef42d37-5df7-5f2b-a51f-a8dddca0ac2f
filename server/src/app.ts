import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { router } from './routes';
import { HttpError } from './util';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.use('/api', router);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // 生产环境：托管前端构建产物（SPA）
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    // 请求体不是合法 JSON（如导入接口上传了非 JSON 文件）→ 400 可定位，而非 500
    if (err instanceof SyntaxError && 'body' in (err as unknown as Record<string, unknown>)) {
      res.status(400).json({
        error: '请求体不是合法 JSON：请检查文件内容与 Content-Type（归档导入请发送 .archive.json 文件内容）',
        details: { code: 'ARCHIVE_FORMAT', issues: [{ code: 'ARCHIVE_FORMAT', message: (err as Error).message, path: '$' }] },
      });
      return;
    }
    const code = (err as { code?: string })?.code;
    if (code === '40001' || code === '23505') {
      res.status(409).json({ error: '并发冲突或数据已变化，请刷新后重试' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}
