"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const routes_1 = require("./routes");
const util_1 = require("./util");
function createApp() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json({ limit: '4mb' }));
    app.use('/api', routes_1.router);
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    // 生产环境：托管前端构建产物（SPA）
    const publicDir = path_1.default.join(__dirname, '..', 'public');
    if (fs_1.default.existsSync(publicDir)) {
        app.use(express_1.default.static(publicDir));
        app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path_1.default.join(publicDir, 'index.html')));
    }
    app.use((err, _req, res, _next) => {
        if (err instanceof util_1.HttpError) {
            res.status(err.status).json({ error: err.message, details: err.details });
            return;
        }
        // 请求体不是合法 JSON（如导入接口上传了非 JSON 文件）→ 400 可定位，而非 500
        if (err instanceof SyntaxError && 'body' in err) {
            res.status(400).json({
                error: '请求体不是合法 JSON：请检查文件内容与 Content-Type（归档导入请发送 .archive.json 文件内容）',
                details: { code: 'ARCHIVE_FORMAT', issues: [{ code: 'ARCHIVE_FORMAT', message: err.message, path: '$' }] },
            });
            return;
        }
        const code = err?.code;
        if (code === '40001' || code === '23505') {
            res.status(409).json({ error: '并发冲突或数据已变化，请刷新后重试' });
            return;
        }
        console.error(err);
        res.status(500).json({ error: '服务器内部错误' });
    });
    return app;
}
