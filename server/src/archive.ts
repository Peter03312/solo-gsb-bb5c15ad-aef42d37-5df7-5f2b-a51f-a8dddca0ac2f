import { PoolClient } from 'pg';
import { CollationView, GroupDTO, ManuscriptRow } from './types';
import { charLen, HttpError, isInt, rangesOverlap } from './util';
import { validateGroups } from './validate';
import { buildRestorePlan } from './restore';

/**
 * 可迁移归档（Transferable Archive）：
 * 整理者可将一篇文献在工作区导出为自描述的 JSON 归档，并把同一归档导入为一篇全新的、
 * 互相独立的文献。归档与本库内部行 / 组 id 无关，片段一律以「抄本稳定身份 + 抄本内原始行号」
 * 定位，因而可跨库迁移；导入时全部内部标识（行 / 组 / 文献，含每个已发布快照内部）重建。
 */

export const ARCHIVE_FORMAT = 'collation-archive';
export const ARCHIVE_FORMAT_VERSION = 1;

export interface ArchiveFragment {
  msId: number;
  missing: boolean;
  lineNo?: number;
  startCp?: number;
  endCp?: number;
}

export interface ArchiveGroup {
  ord: number;
  broken: boolean;
  fragments: ArchiveFragment[];
}

export interface ArchiveEdition {
  editionNo: number;
  createdAt: string | null;
  /** 发布当时的完整读模型（内部 id 在导入时重建）。 */
  snapshot: CollationView;
}

export interface Archive {
  format: string;
  formatVersion: number;
  exportedAt: string;
  source: {
    documentId: number;
    title: string;
    baseMsId: number;
    version: number;
    publishedVer: number;
  };
  manuscripts: Array<{ id: number; name: string; position: number }>;
  lines: Array<{ msId: number; lineNo: number; content: string }>;
  groups: ArchiveGroup[];
  editions: ArchiveEdition[];
}

export interface ImportPlan {
  title: string;
  source: Archive['source'];
  baseMsId: number;
  manuscripts: Archive['manuscripts'];
  lines: Archive['lines'];
  groups: ArchiveGroup[];
  editions: ArchiveEdition[];
  stats: {
    manuscriptCount: number;
    lineCount: number;
    groupCount: number;
    brokenCount: number;
    fragmentCount: number;
    missingCount: number;
    editionCount: number;
  };
}

interface ArchiveIssue {
  code: string;
  message: string;
  /** 可定位路径，如 groups[2].fragments[0] / editions[1]。 */
  path?: string;
  groupOrd?: number;
  msName?: string;
  lineNo?: number;
  editionNo?: number;
}

function rejectArchive(message: string, issues: ArchiveIssue[]): never {
  throw new HttpError(400, `归档无法导入：${message}；已整次拒绝，未创建任何文献`, {
    code: 'ARCHIVE_INVALID',
    issues,
  });
}

// ---------- 导出：在同一事务中读取已提交的一致状态 ----------

/**
 * 从数据库构建归档。必须在单个事务（只读即可）中调用，保证「工作版 + 全部快照」
 * 取自同一个已提交版本，绝无半新半旧。
 */
export async function buildArchive(client: PoolClient, docId: number): Promise<Archive> {
  const { rows: docs } = await client.query(
    'SELECT id, title, base_ms_id, version, published_ver FROM documents WHERE id=$1',
    [docId]
  );
  if (docs.length === 0) throw new HttpError(404, `文献 #${docId} 不存在`);
  const doc = docs[0] as {
    id: number; title: string; base_ms_id: number | null; version: number; published_ver: number;
  };
  if (doc.base_ms_id == null) throw new HttpError(400, '该文献尚未选定底本，无法导出');

  const { rows: mss } = await client.query<ManuscriptRow>(
    'SELECT id, doc_id, name, position FROM manuscripts WHERE doc_id=$1 ORDER BY position, id',
    [docId]
  );
  const msIds = mss.map((m) => m.id);
  const { rows: lines } = await client.query<{ ms_id: number; line_no: number; content: string }>(
    'SELECT ms_id, line_no, content FROM lines WHERE ms_id = ANY($1::bigint[]) ORDER BY ms_id, line_no',
    [msIds]
  );
  const { rows: lineRows } = await client.query<{ id: number; ms_id: number; line_no: number }>(
    'SELECT id, ms_id, line_no FROM lines WHERE ms_id = ANY($1::bigint[])',
    [msIds]
  );
  const lineRef = new Map<number, { msId: number; lineNo: number }>();
  for (const lr of lineRows) lineRef.set(lr.id, { msId: lr.ms_id, lineNo: lr.line_no });

  const { rows: groups } = await client.query<{ id: number; ord: number; broken: boolean }>(
    'SELECT id, ord, broken FROM grp WHERE doc_id=$1 ORDER BY ord',
    [docId]
  );
  const { rows: frags } = await client.query<{
    group_id: number; ms_id: number; line_id: number | null;
    start_cp: number | null; end_cp: number | null; missing: boolean;
  }>(
    `SELECT group_id, ms_id, line_id, start_cp, end_cp, missing
     FROM fragments WHERE doc_id=$1 ORDER BY group_id, ms_id`,
    [docId]
  );
  const { rows: editions } = await client.query<{
    edition_no: number; snapshot: CollationView; created_at: Date | null;
  }>(
    'SELECT edition_no, snapshot, created_at FROM editions WHERE doc_id=$1 ORDER BY edition_no',
    [docId]
  );

  const fragsByGroup = new Map<number, typeof frags>();
  for (const f of frags) {
    const arr = fragsByGroup.get(f.group_id) ?? [];
    arr.push(f);
    fragsByGroup.set(f.group_id, arr);
  }

  const archiveGroups: ArchiveGroup[] = groups.map((g) => ({
    ord: g.ord,
    broken: g.broken,
    fragments: (fragsByGroup.get(g.id) ?? []).map((f) => {
      if (f.missing || f.line_id == null) return { msId: f.ms_id, missing: true };
      const ref = lineRef.get(f.line_id);
      if (!ref) throw new HttpError(500, '导出失败：片段引用了不属于本文献的行');
      return {
        msId: f.ms_id,
        missing: false,
        lineNo: ref.lineNo,
        startCp: f.start_cp ?? undefined,
        endCp: f.end_cp ?? undefined,
      };
    }),
  }));

  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      documentId: doc.id,
      title: doc.title,
      baseMsId: doc.base_ms_id,
      version: doc.version,
      publishedVer: doc.published_ver,
    },
    manuscripts: mss.map((m) => ({ id: m.id, name: m.name, position: m.position })),
    lines: lines.map((l) => ({ msId: l.ms_id, lineNo: l.line_no, content: l.content })),
    groups: archiveGroups,
    editions: editions.map((e) => ({
      editionNo: e.edition_no,
      createdAt: e.created_at ? e.created_at.toISOString() : null,
      snapshot: e.snapshot,
    })),
  };
}

// ---------- 导入：纯函数解析 + 单次事务校验 / 落库 ----------

/**
 * 解析归档并完成全部引用与合法性校验（不碰数据库）。
 *  - 完好组：按现行归组规则全量校验（底本唯一、每抄本每组至多一片、不行内重叠、不越界 …）；
 *  - 待修复组：允许保留原有越界坐标，但真实片段不得有负值、逆序、零长度或悬空引用；
 *  - 每个发布版快照都必须能独立构成合法归组（复用恢复模块的同一套校验）。
 * 任何问题都收齐后一次性给出可定位原因（400 ARCHIVE_INVALID）。
 */
export function parseArchive(input: unknown): ImportPlan {
  const issues: ArchiveIssue[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    rejectArchive('根节点必须是 JSON 对象', [
      { code: 'ARCHIVE_FORMAT', message: '归档根节点必须是对象' },
    ]);
  }
  const a = input as Partial<Archive>;

  if (a.format !== ARCHIVE_FORMAT) {
    issues.push({
      code: 'ARCHIVE_FORMAT',
      message: `无法识别的归档格式：format=${JSON.stringify(a.format)}（应为 "${ARCHIVE_FORMAT}"）`,
      path: 'format',
    });
  }
  if (!isInt(a.formatVersion)) {
    issues.push({ code: 'ARCHIVE_FORMAT', message: '缺少整数格式版本号 formatVersion', path: 'formatVersion' });
  } else if (a.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    issues.push({
      code: 'ARCHIVE_FORMAT',
      message: `不支持的归档格式版本：formatVersion=${a.formatVersion}，本系统仅支持 ${ARCHIVE_FORMAT_VERSION}`,
      path: 'formatVersion',
    });
  }

  // 标题
  if (typeof a.source?.title !== 'string' || !a.source.title.trim()) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '缺少文献标题（source.title）', path: 'source.title' });
  }

  // 抄本及顺序
  const manuscripts: Archive['manuscripts'] = [];
  if (!Array.isArray(a.manuscripts) || a.manuscripts.length === 0) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '缺少抄本列表（manuscripts）', path: 'manuscripts' });
  } else {
    const seenIds = new Set<number>();
    const seenPos = new Set<number>();
    a.manuscripts.forEach((m, i) => {
      const p = `manuscripts[${i}]`;
      if (!m || !isInt(m.id) || m.id <= 0) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少合法正整数 id`, path: p });
        return;
      }
      if (seenIds.has(m.id)) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：抄本 id ${m.id} 在归档中重复`, path: p });
        return;
      }
      seenIds.add(m.id);
      if (typeof m.name !== 'string' || !m.name.trim()) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少抄本名称`, path: `${p}.name` });
      }
      if (!isInt(m.position) || m.position <= 0) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少合法顺序 position（≥1）`, path: `${p}.position` });
      } else if (seenPos.has(m.position)) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：顺序 position=${m.position} 重复`, path: `${p}.position` });
      } else {
        seenPos.add(m.position);
      }
      manuscripts.push({
        id: m.id,
        name: typeof m.name === 'string' && m.name.trim() ? m.name : `抄本#${m.id}`,
        position: isInt(m.position) ? m.position : i + 1,
      });
    });
    const positions = manuscripts.map((m) => m.position).sort((x, y) => x - y);
    if (positions.some((pos, i) => pos !== i + 1)) {
      issues.push({ code: 'ARCHIVE_SHAPE', message: '抄本顺序 position 必须为自 1 起的连续编号', path: 'manuscripts' });
    }
  }
  if (Array.isArray(a.manuscripts) && a.manuscripts.length < 2) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '归档至少需包含两份抄本', path: 'manuscripts' });
  }
  const msIds = new Set(manuscripts.map((m) => m.id));
  const msName = (id: number) => manuscripts.find((m) => m.id === id)?.name ?? `抄本#${id}`;

  // 底本
  if (!isInt(a.source?.baseMsId) || a.source.baseMsId <= 0) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '缺少底本（source.baseMsId 需为正整数）', path: 'source.baseMsId' });
  } else if (!msIds.has(a.source.baseMsId)) {
    issues.push({
      code: 'ARCHIVE_DANGLING_REF',
      message: `底本 id=${a.source.baseMsId} 不在归档抄本列表中`,
      path: 'source.baseMsId',
    });
  }
  const baseMsId = isInt(a.source?.baseMsId) ? (a.source.baseMsId as number) : -1;

  // 原始行
  const lines: Archive['lines'] = [];
  const lineContent = new Map<string, string>();
  if (!Array.isArray(a.lines)) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '缺少原始行文（lines）', path: 'lines' });
  } else {
    const seen = new Set<string>();
    a.lines.forEach((l, i) => {
      const p = `lines[${i}]`;
      if (!l || !isInt(l.msId) || !msIds.has(l.msId)) {
        issues.push({ code: 'ARCHIVE_DANGLING_REF', message: `${p}：引用了归档中不存在的抄本`, path: `${p}.msId` });
        return;
      }
      if (!isInt(l.lineNo) || l.lineNo <= 0) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少合法正整数行号 lineNo`, path: `${p}.lineNo`, msName: msName(l.msId) });
        return;
      }
      if (typeof l.content !== 'string') {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少行文字 content`, path: `${p}.content`, msName: msName(l.msId), lineNo: l.lineNo });
        return;
      }
      const key = `${l.msId}:${l.lineNo}`;
      if (seen.has(key)) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：抄本「${msName(l.msId)}」行号 ${l.lineNo} 重复`, path: p, msName: msName(l.msId), lineNo: l.lineNo });
        return;
      }
      seen.add(key);
      lines.push({ msId: l.msId, lineNo: l.lineNo, content: l.content });
      lineContent.set(key, l.content);
    });
    for (const mid of msIds) {
      const nos = lines.filter((l) => l.msId === mid).map((l) => l.lineNo).sort((x, y) => x - y);
      if (nos.some((no, i) => no !== i + 1)) {
        issues.push({
          code: 'ARCHIVE_SHAPE',
          message: `抄本「${msName(mid)}」原始行号不连续（须自 1 起连续）`,
          path: 'lines',
          msName: msName(mid),
        });
      }
    }
  }

  // 对应组 / 片段 / 缺文 / 待修复
  const groups: ArchiveGroup[] = [];
  const placedAll: Array<{ ord: number; msId: number; lineNo: number; s: number; e: number; broken: boolean }> = [];
  if (!Array.isArray(a.groups)) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '缺少对应组列表（groups）', path: 'groups' });
  } else if (a.groups.length === 0) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '归档没有任何对应组（groups 不能为空）', path: 'groups' });
  } else {
    const seenOrd = new Set<number>();
    a.groups.forEach((g, gi) => {
      const p = `groups[${gi}]`;
      if (!g || typeof g !== 'object') {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：不是对象`, path: p });
        return;
      }
      if (!isInt(g.ord) || g.ord <= 0) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少合法正整数组序 ord`, path: `${p}.ord` });
        return;
      }
      if (seenOrd.has(g.ord)) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：组序 ${g.ord} 重复`, path: `${p}.ord`, groupOrd: g.ord });
        return;
      }
      seenOrd.add(g.ord);
      const broken = g.broken === true;
      if (!Array.isArray(g.fragments) || g.fragments.length === 0) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `第 ${g.ord} 组没有任何片段 / 缺文标记`, path: `${p}.fragments`, groupOrd: g.ord });
        return;
      }
      const frags: ArchiveFragment[] = [];
      const seenMs = new Set<number>();
      g.fragments.forEach((f, fi) => {
        const fp = `${p}.fragments[${fi}]`;
        if (!f || typeof f !== 'object' || !isInt(f.msId) || !msIds.has(f.msId)) {
          issues.push({ code: 'ARCHIVE_DANGLING_REF', message: `第 ${g.ord} 组第 ${fi + 1} 个片段引用了归档中不存在的抄本`, path: `${fp}.msId`, groupOrd: g.ord });
          return;
        }
        if (seenMs.has(f.msId)) {
          issues.push({
            code: 'ARCHIVE_DUP_MS',
            message: `第 ${g.ord} 组中抄本「${msName(f.msId)}」出现多个单元（每组每抄本至多一个，缺文也占位）`,
            path: fp, groupOrd: g.ord, msName: msName(f.msId),
          });
          return;
        }
        seenMs.add(f.msId);
        if (f.missing) {
          frags.push({ msId: f.msId, missing: true });
          return;
        }
        if (!isInt(f.lineNo) || f.lineNo <= 0) {
          issues.push({ code: 'ARCHIVE_SHAPE', message: `第 ${g.ord} 组「${msName(f.msId)}」真实片段缺少合法行号 lineNo`, path: `${fp}.lineNo`, groupOrd: g.ord, msName: msName(f.msId) });
          return;
        }
        if (!isInt(f.startCp) || !isInt(f.endCp)) {
          issues.push({ code: 'ARCHIVE_SHAPE', message: `第 ${g.ord} 组「${msName(f.msId)}」真实片段缺少整数码点区间 startCp/endCp`, path: fp, groupOrd: g.ord, msName: msName(f.msId), lineNo: f.lineNo });
          return;
        }
        // 硬约束（完好组与待修复组共同遵守）：不得负值、逆序、零长度
        if (f.startCp < 0 || f.endCp <= f.startCp) {
          issues.push({
            code: 'ARCHIVE_BAD_RANGE',
            message: `第 ${g.ord} 组「${msName(f.msId)}」片段区间非法 [${f.startCp}, ${f.endCp})（需 0 ≤ startCp < endCp）`,
            path: `${fp}.startCp`, groupOrd: g.ord, msName: msName(f.msId), lineNo: f.lineNo,
          });
          return;
        }
        // 硬约束：悬空引用（引用的行必须真实存在）
        if (!lineContent.has(`${f.msId}:${f.lineNo}`)) {
          issues.push({
            code: 'ARCHIVE_DANGLING_REF',
            message: `第 ${g.ord} 组「${msName(f.msId)}」引用了不存在的第 ${f.lineNo} 行（悬空引用）`,
            path: `${fp}.lineNo`, groupOrd: g.ord, msName: msName(f.msId), lineNo: f.lineNo,
          });
          return;
        }
        // 越界仅在待修复组允许保留；完好组稍后由现行归组规则统一校验
        frags.push({ msId: f.msId, missing: false, lineNo: f.lineNo, startCp: f.startCp, endCp: f.endCp });
        placedAll.push({ ord: g.ord, msId: f.msId, lineNo: f.lineNo, s: f.startCp, e: f.endCp, broken });
      });
      groups.push({ ord: g.ord, broken, fragments: frags });
    });

    // 组序自 1 连续
    const ords = groups.map((g) => g.ord).sort((x, y) => x - y);
    if (ords.some((o, i) => o !== i + 1)) {
      issues.push({ code: 'ARCHIVE_SHAPE', message: '组序 ord 必须自 1 起连续，不能缺号', path: 'groups' });
    }

    if (issues.length === 0) {
      // 完好组：复用「整批保存对应组」的现行归组规则全量校验。
      // 待修复组的（允许越界的）片段不进该校验，但要额外检查完好片段与待修复片段
      // 在同一行的可见区间不得重叠（现行系统不产生这种状态）。
      const pseudoLineId = new Map<string, number>();
      lines.forEach((l, i) => pseudoLineId.set(`${l.msId}:${l.lineNo}`, -(i + 1)));
      const syntheticGroups: GroupDTO[] = groups
        .filter((g) => !g.broken)
        .map((g) => ({
          ord: g.ord,
          fragments: g.fragments.map((f) =>
            f.missing
              ? { msId: f.msId, missing: true }
              : {
                  msId: f.msId, missing: false,
                  lineId: pseudoLineId.get(`${f.msId}:${f.lineNo}`),
                  startCp: f.startCp, endCp: f.endCp,
                }
          ),
        }));
      try {
        validateGroups(syntheticGroups, {
          baseMsId,
          manuscripts: manuscripts.map((m) => ({ id: m.id, doc_id: 0, name: m.name, position: m.position })),
          lines: lines.map((l, i) => ({
            id: -(i + 1), ms_id: l.msId, line_no: l.lineNo, content: l.content,
          })),
        });
      } catch (e) {
        if (e instanceof HttpError && Array.isArray(e.details)) {
          for (const d of e.details as Array<Record<string, unknown>>) {
            issues.push({
              code: String(d.code ?? 'ILLEGAL_GROUPING'),
              message: `完好组按现行归组规则校验未通过：${String(d.message ?? '非法区间')}`,
              path: 'groups',
              groupOrd: isInt(d.groupOrd) ? (d.groupOrd as number) : undefined,
              msName: typeof d.msName === 'string' ? d.msName : undefined,
              lineNo: isInt(d.lineNo) ? (d.lineNo as number) : undefined,
            });
          }
        } else {
          throw e;
        }
      }

      // 完好片段 vs 待修复片段：行内可见区间重叠也属完好组非法区间
      const intact = placedAll.filter((x) => !x.broken);
      const retained = placedAll.filter((x) => x.broken);
      const lenOf = (msId: number, lineNo: number) => charLen(lineContent.get(`${msId}:${lineNo}`) ?? '');
      for (const x of intact) {
        const xe = Math.min(x.e, lenOf(x.msId, x.lineNo));
        for (const y of retained) {
          if (x.msId !== y.msId || x.lineNo !== y.lineNo) continue;
          const ys = Math.max(0, y.s);
          const ye = Math.min(y.e, lenOf(y.msId, y.lineNo));
          if (rangesOverlap(x.s, xe, ys, ye)) {
            issues.push({
              code: 'OVERLAP',
              message: `完好第 ${x.ord} 组「${msName(x.msId)}」与待修复第 ${y.ord} 组在第 ${x.lineNo} 行的现存片段区间重叠（完好组须符合现行归组规则）`,
              path: 'groups',
              groupOrd: x.ord,
              msName: msName(x.msId),
              lineNo: x.lineNo,
            });
          }
        }
      }
    }
  }

  // 发布版：编号连续，且每个快照都能构成合法归组
  const editions: ArchiveEdition[] = [];
  if (!Array.isArray(a.editions)) {
    issues.push({ code: 'ARCHIVE_SHAPE', message: '缺少发布版字段（editions，可为空数组）', path: 'editions' });
  } else {
    const seenNo = new Set<number>();
    a.editions.forEach((e, i) => {
      const p = `editions[${i}]`;
      if (!e || typeof e !== 'object') {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：不是对象`, path: p });
        return;
      }
      if (!isInt(e.editionNo) || e.editionNo <= 0) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：缺少合法正整数 editionNo`, path: `${p}.editionNo` });
        return;
      }
      if (seenNo.has(e.editionNo)) {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：发布版编号 ${e.editionNo} 重复`, path: `${p}.editionNo`, editionNo: e.editionNo });
        return;
      }
      seenNo.add(e.editionNo);
      if (e.createdAt != null && typeof e.createdAt !== 'string') {
        issues.push({ code: 'ARCHIVE_SHAPE', message: `${p}：createdAt 须为 ISO 字符串或 null`, path: `${p}.createdAt`, editionNo: e.editionNo });
      }
      if (!e.snapshot || typeof e.snapshot !== 'object') {
        issues.push({ code: 'ARCHIVE_CORRUPT_SNAPSHOT', message: `第 ${e.editionNo} 版快照缺失或不是对象（损坏快照）`, path: `${p}.snapshot`, editionNo: e.editionNo });
        return;
      }
      // 每个发布版都必须能独立构成合法归组（复用恢复模块同一套快照校验）
      try {
        buildRestorePlan(e.snapshot);
      } catch (e2) {
        const he = e2 as HttpError;
        const det = he?.details as { issues?: Array<Record<string, unknown>> } | undefined;
        const subs = Array.isArray(det?.issues) ? (det as { issues: Array<Record<string, unknown>> }).issues : [];
        if (subs.length > 0) {
          for (const s of subs) {
            issues.push({
              code: 'ARCHIVE_CORRUPT_SNAPSHOT',
              message: `第 ${e.editionNo} 版发布快照无法构成合法归组：${String(s.message ?? s.code ?? '快照损坏')}`,
              path: p,
              editionNo: e.editionNo,
              groupOrd: isInt(s.groupOrd) ? (s.groupOrd as number) : undefined,
              msName: typeof s.msName === 'string' ? s.msName : undefined,
              lineNo: isInt(s.lineNo) ? (s.lineNo as number) : undefined,
            });
          }
        } else {
          issues.push({
            code: 'ARCHIVE_CORRUPT_SNAPSHOT',
            message: `第 ${e.editionNo} 版发布快照损坏，无法构成合法归组：${String(he?.message ?? '无法解析')}`,
            path: p,
            editionNo: e.editionNo,
          });
        }
        return;
      }
      // 快照内抄本引用必须落在归档抄本集合中（恢复时需为它们重建身份）
      const snap = e.snapshot as CollationView;
      const dangling = (Array.isArray(snap.manuscripts) ? snap.manuscripts : [])
        .map((m) => m?.id)
        .filter((mid) => !isInt(mid) || !msIds.has(mid as number));
      if (dangling.length > 0) {
        issues.push({
          code: 'ARCHIVE_DANGLING_REF',
          message: `第 ${e.editionNo} 版快照引用了归档抄本列表之外的抄本 id=${JSON.stringify(dangling)}`,
          path: `${p}.snapshot.manuscripts`,
          editionNo: e.editionNo,
        });
      }
      editions.push({ editionNo: e.editionNo, createdAt: e.createdAt ?? null, snapshot: e.snapshot });
    });

    const nos = editions.map((e) => e.editionNo).sort((x, y) => x - y);
    if (nos.some((no, i) => no !== i + 1)) {
      issues.push({ code: 'ARCHIVE_SHAPE', message: '发布版编号 editionNo 必须自 1 起连续', path: 'editions' });
    }
    // 与源文献发布计数自洽（防止半截归档）
    if (isInt(a.source?.publishedVer) && (a.source.publishedVer as number) !== editions.length) {
      issues.push({
        code: 'ARCHIVE_CORRUPT_SNAPSHOT',
        message: `source.publishedVer=${a.source?.publishedVer} 与归档内快照数量 ${editions.length} 不一致（归档不完整）`,
        path: 'source.publishedVer',
      });
    }
  }

  if (issues.length > 0) rejectArchive(`共 ${issues.length} 处问题`, issues);

  let fragmentCount = 0;
  let missingCount = 0;
  for (const g of groups) {
    fragmentCount += g.fragments.length;
    missingCount += g.fragments.filter((f) => f.missing).length;
  }

  return {
    title: (a.source as { title: string }).title.trim(),
    source: a.source as Archive['source'],
    baseMsId,
    manuscripts,
    lines,
    groups,
    editions: editions.sort((x, y) => x.editionNo - y.editionNo),
    stats: {
      manuscriptCount: manuscripts.length,
      lineCount: lines.length,
      groupCount: groups.length,
      brokenCount: groups.filter((g) => g.broken).length,
      fragmentCount,
      missingCount,
      editionCount: editions.length,
    },
  };
}

/**
 * 重写一个快照内部的全部身份标识：
 *  - manuscript id 走「归档身份 → 新文献身份」映射（工作版与各旧版同一映射）；
 *  - group id / line id 仅在快照内部被引用，按快照本地从 1 重排，保持内部关联一致；
 *  - document.id/baseMsId 指向新文献；标题、发布版号、历史版本号与发布时间原样保留。
 */
export function remapSnapshot(snapshot: CollationView, docId: number, msIdMap: Map<number, number>): CollationView {
  // 先建组 id 映射（组是快照内部身份，按快照本地顺序重排）
  const groupIdMap = new Map<number, number>();
  (snapshot.groups ?? []).forEach((g, i) => groupIdMap.set(g.id, i + 1));

  // 行 id 仅在快照内部出现（rawByMs 行标识 / covered 不含行 id），按出现顺序重排
  let lineSeq = 0;
  const lineIdMap = new Map<number, number>();
  const mapLine = (id: number): number => {
    let n = lineIdMap.get(id);
    if (n == null) {
      n = ++lineSeq;
      lineIdMap.set(id, n);
    }
    return n;
  };

  const newBaseMsId =
    snapshot.document.baseMsId != null ? (msIdMap.get(snapshot.document.baseMsId) ?? snapshot.document.baseMsId) : null;

  return {
    ...snapshot,
    document: {
      ...snapshot.document,
      id: docId,
      baseMsId: newBaseMsId,
    },
    manuscripts: (snapshot.manuscripts ?? []).map((m) => ({
      ...m,
      id: msIdMap.get(m.id) ?? m.id,
      isBase: msIdMap.get(m.id) === newBaseMsId,
    })),
    groups: (snapshot.groups ?? []).map((g) => ({
      ...g,
      id: groupIdMap.get(g.id) ?? g.id,
      cells: g.cells.map((c) => ({ ...c, msId: msIdMap.get(c.msId) ?? c.msId })),
    })),
    rawByMs: (snapshot.rawByMs ?? []).map((raw) => ({
      msId: msIdMap.get(raw.msId) ?? raw.msId,
      lines: raw.lines.map((ln) => ({
        lineId: mapLine(ln.lineId),
        lineNo: ln.lineNo,
        content: ln.content,
        covered: ln.covered.map((c) => ({
          startCp: c.startCp,
          endCp: c.endCp,
          groupId: groupIdMap.get(c.groupId) ?? c.groupId,
          broken: c.broken,
        })),
      })),
    })),
  };
}

/**
 * 在单次事务内按导入计划创建一篇全新文献（不动任何源文献）：
 * 文献 / 抄本 / 行 / 组全部取得当前有效新标识；片段以「抄本身份 + 行号」重新关联；
 * 待修复标记、缺文与越界坐标原样落位；每个发布版快照重写内部标识后入库。
 */
export async function applyImport(client: PoolClient, plan: ImportPlan): Promise<number> {
  const { rows: dr } = await client.query<{ id: number }>(
    'INSERT INTO documents (title, version, published_ver) VALUES ($1, 1, $2) RETURNING id',
    [plan.title, plan.stats.editionCount]
  );
  const docId = dr[0].id;

  const msIdMap = new Map<number, number>();
  for (const m of plan.manuscripts) {
    const { rows } = await client.query<{ id: number }>(
      'INSERT INTO manuscripts (doc_id, name, position) VALUES ($1,$2,$3) RETURNING id',
      [docId, m.name, m.position]
    );
    msIdMap.set(m.id, rows[0].id);
  }
  const baseMsId = msIdMap.get(plan.baseMsId);
  if (baseMsId == null) throw new HttpError(500, '导入失败：底本无法重建');
  await client.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [baseMsId, docId]);

  const lineIdMap = new Map<string, number>();
  for (const ms of plan.manuscripts) {
    for (const l of plan.lines.filter((x) => x.msId === ms.id).sort((x, y) => x.lineNo - y.lineNo)) {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3) RETURNING id',
        [msIdMap.get(l.msId), l.lineNo, l.content]
      );
      lineIdMap.set(`${l.msId}:${l.lineNo}`, rows[0].id);
    }
  }

  for (const g of plan.groups) {
    const { rows: gr } = await client.query<{ id: number }>(
      'INSERT INTO grp (doc_id, ord, broken) VALUES ($1,$2,$3) RETURNING id',
      [docId, g.ord, g.broken]
    );
    const gid = gr[0].id;
    for (const f of g.fragments) {
      if (f.missing) {
        await client.query(
          'INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,NULL,NULL,NULL,TRUE)',
          [gid, docId, msIdMap.get(f.msId)]
        );
      } else {
        const lineId = lineIdMap.get(`${f.msId}:${f.lineNo}`);
        if (lineId == null) throw new HttpError(500, '导入失败：片段无法关联到重建后的行');
        await client.query(
          'INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing) VALUES ($1,$2,$3,$4,$5,$6,FALSE)',
          [gid, docId, msIdMap.get(f.msId), lineId, f.startCp, f.endCp]
        );
      }
    }
  }

  for (const e of plan.editions) {
    const snapshot = remapSnapshot(e.snapshot, docId, msIdMap);
    await client.query(
      'INSERT INTO editions (doc_id, edition_no, snapshot, created_at) VALUES ($1,$2,$3,$4)',
      [docId, e.editionNo, JSON.stringify(snapshot), e.createdAt]
    );
  }

  return docId;
}

// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\x00-\x1f]+/g;

/** 生成安全的导出文件名。 */
export function safeFileName(title: string): string {
  return title.replace(UNSAFE_FILE_CHARS, '_').slice(0, 80) || 'document';
}
