import { useRef, useState } from 'react';
import { api, ApiError, exportArchiveUrl } from '../api';
import type { ArchiveImportResult, CollationView } from '../types';
import { ErrorBox } from '../ErrorBox';

/**
 * 可迁移归档：
 *  - 导出：下载当前文献同一已提交版本的自描述 JSON（标题 / 抄本与行序 / 底本 /
 *    当前对应组片段 / 缺文与待修复 / 工作版版本号 / 全部已发布版快照，带格式版本）；
 *  - 导入：选择归档文件后在单次事务中校验并创建一篇全新的独立文献；
 *    同一文件可重复导入，互不影响，源文献也不被改动。
 */
export function ArchiveTab({
  view,
  onOpenDocument,
}: {
  view: CollationView;
  onOpenDocument: (id: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<unknown>(null);
  const [result, setResult] = useState<ArchiveImportResult | null>(null);

  const pickFile = () => fileRef.current?.click();

  const onFile = async (file: File) => {
    setFileName(file.name);
    setError(null);
    setIssues(null);
    setResult(null);
    setBusy(true);
    try {
      const text = await file.text();
      let archive: unknown;
      try {
        archive = JSON.parse(text);
      } catch {
        throw new ApiError(400, '文件不是合法 JSON：请选择本系统导出的 .archive.json 归档文件', {
          code: 'ARCHIVE_FORMAT',
          issues: [{ code: 'ARCHIVE_FORMAT', message: 'JSON 解析失败（文件可能已损坏或不是归档文件）', path: '$' }],
        });
      }
      const r = await api.importArchive(archive);
      setResult(r);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setIssues((e.details as { issues?: unknown } | undefined)?.issues ?? e.details ?? null);
      } else {
        setError(String((e as Error).message ?? e));
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="card">
        <h2>导出为可迁移归档</h2>
        <div className="muted" style={{ marginBottom: 10 }}>
          归档取当前文献<strong>同一已提交版本</strong>，包含：标题、抄本及原始行序、底本、
          当前对应组的片段、缺文与待修复状态、工作版版本号（v{view.document.version}）和
          全部 {view.document.publishedVer} 个已发布版快照；文件带格式标识
          <code> collation-archive v1</code>。导出是只读操作，不改动本文献。
        </div>
        <a className="primary" href={exportArchiveUrl(view.document.id)}
           download style={{ textDecoration: 'none', display: 'inline-block', padding: '6px 14px' }}>
          ⬇ 下载归档文件（JSON）
        </a>
      </div>

      <div className="card">
        <h2>从归档导入为新文献</h2>
        <div className="muted" style={{ marginBottom: 10 }}>
          选择本系统导出的归档文件（<code>.archive.json</code>）。服务端在<strong>单次事务</strong>中
          校验格式与全部引用关系后，创建一篇与源文献互相独立的新文献：内部行 / 组标识全部重建，
          旧发布版快照一并迁入、仍可阅读 / 对照 / 恢复，新文献可继续编辑并按现有门禁发布。
          同一文件可重复导入，每次各自生成独立文献。
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        <div className="row-flex">
          <button className="primary" disabled={busy} onClick={pickFile}>
            {busy ? '导入校验中…' : '选择归档文件并导入'}
          </button>
          {fileName && <span className="muted">已选文件：{fileName}</span>}
        </div>

        {error && <div style={{ marginTop: 12 }}><ErrorBox message={error} issues={issues} /></div>}

        {result && (
          <div className="ok-box" style={{ marginTop: 12 }}>
            <div>
              ✓ 导入成功：新文献「{result.title}」（文献 #{result.documentId}）已创建，
              与源文献 #{result.source.documentId}（导出时 v{result.source.version}
              {result.source.exportedAt ? `，导出时间 ${new Date(result.source.exportedAt).toLocaleString('zh-CN')}` : ''}）
              完全独立。
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              重建：抄本 {result.imported.manuscriptCount} 份 · 原始行 {result.imported.lineCount} 行 ·
              对应组 {result.imported.groupCount} 组（待修复 {result.imported.brokenCount}）·
              片段 {result.imported.fragmentCount}（缺文 {result.imported.missingCount}）·
              已发布版快照 {result.imported.editionCount} 个。
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={() => onOpenDocument(result.documentId)}>打开导入的文献 →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
