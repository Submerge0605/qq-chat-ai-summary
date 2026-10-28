// OneBot 11 HTTP client (only the actions v0.3 needs).
// Works against real NapCat or the bundled mock server.

export class OneBotError extends Error {
  constructor(message, code = 'ONEBOT_ERROR', retcode = null) {
    super(message);
    this.code = code;
    this.retcode = retcode;
  }
}

export class OneBotClient {
  constructor({ base = 'http://127.0.0.1:3000', token = '', timeoutMs = 15000 } = {}) {
    this.base = base.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async call(action, params = {}) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(`${this.base}/${action}`, {
        method: 'POST',
        headers,
        // OneBot HTTP: the action lives in the URL path and the BODY is the
        // params object itself. Wrapping it as {action, params} makes NapCat's
        // schema validation fail with "Expected required property".
        body: JSON.stringify(params || {}),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      const isTimeout = err?.name === 'TimeoutError';
      throw new OneBotError(
        isTimeout ? `NapCat 接口超时（${this.base}）` : `无法连接 NapCat（${this.base}）：请确认 QQ 与 NapCat 已启动`,
        isTimeout ? 'ONEBOT_TIMEOUT' : 'ONEBOT_UNREACHABLE'
      );
    }
    let json = null;
    try { json = await res.json(); } catch { /* body may not be JSON */ }
    // NapCat rejects a bad token with HTTP 403 whose body IS json but is served
    // as text/html (`res.status(403).send(JSON.stringify({message}))`), so it has
    // no status/retcode envelope. Check the HTTP status before the envelope.
    if (res.status === 401 || res.status === 403) {
      const serverMsg = json && typeof json.message === 'string' ? `（NapCat: ${json.message}）` : '';
      throw new OneBotError(
        `NapCat 拒绝访问（HTTP ${res.status}）：token 不匹配${serverMsg}。请在程序设置里填与 NapCat 一致的 token，或把 NapCat 侧 token 清空`,
        'ONEBOT_AUTH',
        res.status
      );
    }
    if (!json) throw new OneBotError(`NapCat 返回非 JSON（HTTP ${res.status}）`, 'ONEBOT_BAD_RESPONSE');
    // Business failures come back as retcode 200 + status "failed" (not 1400).
    if (json.status === 'failed' || (json.retcode && json.retcode !== 0)) {
      throw new OneBotError(json.message || json.wording || `NapCat 返回失败（retcode=${json.retcode}）`, 'ONEBOT_FAILED', json.retcode);
    }
    return json.data;
  }

  async status() {
    // get_status must succeed, otherwise the endpoint is simply not there.
    // NapCat's get_status.online is the only reliable login signal; get_login_info
    // may still hand back a selfInfo with user_id 0 when logged out.
    const status = await this.call('get_status');
    const login = await this.call('get_login_info').catch(() => null);
    const online = !!(status && status.online);
    const uin = login && Number(login.user_id) > 0 ? String(login.user_id) : '';
    const loggedIn = online || !!uin;
    return {
      reachable: true,
      loggedIn,
      uin,
      nickname: loggedIn ? String(login?.nickname || '') : '',
      online,
      message: loggedIn ? '' : 'NapCat 已连接，但尚未登录 QQ（请在 QQ 客户端完成扫码登录）'
    };
  }

  async groupList() {
    const data = await this.call('get_group_list');
    return (Array.isArray(data) ? data : []).map((g) => ({
      id: String(g.group_id ?? g.groupId ?? ''),
      name: String(g.group_name ?? g.groupName ?? g.group_id ?? ''),
      type: 'group',
      memberCount: Number(g.member_count ?? g.memberCount ?? 0)
    }));
  }

  async friendList() {
    const data = await this.call('get_friend_list');
    return (Array.isArray(data) ? data : []).map((f) => ({
      id: String(f.user_id ?? f.userId ?? ''),
      name: String(f.remark || f.nickname || f.user_id || ''),
      type: 'friend',
      memberCount: 0
    }));
  }

  /** qq号 -> 群名片/昵称，用于把 @123456 还原成 @某人。 */
  async groupMemberMap(groupId) {
    const map = new Map();
    try {
      const data = await this.call('get_group_member_list', { group_id: Number(groupId) });
      const list = Array.isArray(data) ? data : [];
      for (const m of list) {
        const uid = String(m.user_id ?? '');
        const name = String(m.card || m.nickname || uid);
        if (uid) map.set(uid, name);
      }
    } catch {
      /* 拿不到成员列表就退回 qq 号，不阻断摘要 */
    }
    return map;
  }

  /**
   * Pull history backwards via message_seq, filter by time on the client.
   *
   * Display rules for mentions / replies:
   *  - `message_seq: 0` means "start from the latest";
   *  - dedupe by message_id, never by seq (seq is not unique);
   *  - stop when a page is short, when the anchor stops moving, when history
   *    ends, or when we already passed the requested start time.
   *
   * ⚠️ DO NOT "optimise" this by using seq as the dedupe/anchor key for
   * deduplication: a real 7295-message export had only 7245 unique seq values
   * (50 duplicates). seq is only valid for paging anchors and ordering.
   */
  async history({ type = 'group', id, from, to, max = 20000, pageSize = 500, onPage = null } = {}) {
    const action = type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const idKey = type === 'group' ? 'group_id' : 'user_id';
    const fromMs = from ? new Date(from).getTime() : 0;
    const seen = new Map();          // message_id -> raw message (dedupe key)
    let candidates = [];             // candidate anchors from the previous page (old -> new)
    let ci = 0;                      // current candidate index (bumped when an anchor is stale)
    let staleSkips = 0;              // how many stale/deleted anchors we had to skip
    let pages = 0;
    let stopReason = '';
    const maxPages = 5000;

    const callWithRetry = async (params) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this.call(action, params);
        } catch (err) {
          lastErr = err;
          if (!/TIMEOUT|UNREACHABLE/.test(String(err.code))) throw err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      throw lastErr;
    };

    while (seen.size < max && pages < maxPages) {
      // NapCat's schema requires message_seq to be a STRING (number 0 is
      // tolerated, null is not), so always send it as a string.
      //
      // Paging rule discovered against NapCat 4.18.28 (see probe notes):
      //  - message_seq "0" (no reverse) -> latest page;
      //  - message_seq <oldest message_id> + reverse_order:true -> the page
      //    ending at that anchor, i.e. the NEXT OLDER page.
      // Without reverse_order the same call returns the same newest window,
      // which is exactly why early builds only ever saw ~500 messages.
      //
      // Anchors can go stale (a recalled/deleted message makes NapCat answer
      // "消息<id>不存在"). We keep the whole previous page as candidate anchors
      // and fall back to the next-oldest one instead of aborting the run.
      const anchorId = candidates.length ? candidates[ci] : '0';
      const params = { [idKey]: Number.isFinite(Number(id)) ? Number(id) : id, count: pageSize, message_seq: String(anchorId) };
      if (candidates.length) params.reverse_order = true;

      let data;
      try {
        data = await callWithRetry(params);
      } catch (err) {
        const staleAnchor = /不存在|not\s*found/i.test(String(err.message || ''));
        if (staleAnchor && candidates.length && ci + 1 < Math.min(candidates.length, 50)) {
          ci += 1;
          staleSkips += 1;
          continue;
        }
        if (staleAnchor && candidates.length) { stopReason = 'anchor-missing'; break; }
        throw err;
      }
      const list = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
      pages += 1;
      if (!list.length) { stopReason = 'empty-page'; break; }

      let oldestKey = '';
      let oldestMs = Infinity;
      for (const m of list) {
        const ms = oneBotTimeMs(m);
        const key = String(m.message_id ?? m.message_seq ?? '');
        if (!key) continue;
        if (ms && ms < oldestMs) { oldestMs = ms; oldestKey = key; }
        if (!seen.has(key)) seen.set(key, m);
      }
      if (onPage) onPage({ pages, collected: seen.size, oldestMs });
      // "short page" is NOT a stop condition: NapCat can cap count server-side.
      if (!oldestKey) { stopReason = 'no-id'; break; }
      if (oldestKey === anchorId) { stopReason = 'no-progress'; break; }
      if (oldestMs < fromMs - 86400000) { stopReason = 'passed-range'; break; }
      if (seen.size >= max) { stopReason = 'max-reached'; break; }

      // Next page's candidate anchors: this page ordered old -> new.
      candidates = [...list]
        .sort((a, b) => oneBotTimeMs(a) - oneBotTimeMs(b))
        .map((m) => String(m.message_id ?? m.message_seq ?? ''))
        .filter(Boolean);
      ci = 0;
    }

    return { messages: [...seen.values()], pages, stopReason, staleSkips };
  }
}

export function oneBotTimeMs(m) {
  const t = m?.time;
  if (!t) return 0;
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export function oneBotToCanonical(m, index = 0, opts = {}) {
  const ms = oneBotTimeMs(m);
  const segs = Array.isArray(m?.message) ? m.message : [];
  const mentions = opts.mentions instanceof Map ? opts.mentions : null;
  const textParts = [];
  let kind = 'text';
  let replyTo = null;
  let replyPrefix = '';
  let hasImage = false;
  let hasFace = false;
  for (const seg of segs) {
    const t = seg?.type;
    const d = seg?.data || {};
    if (t === 'text') textParts.push(String(d.text || ''));
    else if (t === 'at') {
      const uid = String(d.qq || '');
      const name = d.name || (mentions && mentions.get(uid)) || uid;
      textParts.push(`@${name}`);
    }
    else if (t === 'image') { hasImage = true; textParts.push('[图片]'); }
    else if (t === 'face' || t === 'mface') { hasFace = true; textParts.push('[表情]'); }
    else if (t === 'reply') { replyTo = String(d.id || ''); replyPrefix = '[回复消息]'; }
    else if (t === 'record') textParts.push('[语音]');
    else if (t === 'video') textParts.push('[视频]');
    else if (t === 'file') textParts.push(`[文件: ${d.name || d.file || ''}]`);
    else if (t === 'forward') textParts.push('[合并转发]');
  }
  if (typeof m?.message === 'string') textParts.push(m.message);
  let text = (replyPrefix + textParts.join('')).trim();
  if (!replyPrefix && !text && hasImage) { text = '[图片]'; kind = 'image'; }
  else if (!replyPrefix && !text && hasFace) { text = '[表情]'; kind = 'sticker'; }
  if (m?.msg_kind) kind = m.msg_kind;
  const sender = m?.sender || {};
  const time = new Date(ms || 0);
  return {
    id: String(m?.message_id ?? m?.message_seq ?? `m${index}`),
    t: time,
    tIso: time.toISOString(),
    from: String(sender.card || sender.nickname || sender.name || sender.user_id || '未知成员'),
    uin: String(sender.user_id || sender.uin || ''),
    kind,
    text: text || '[空消息]',
    replyTo,
    raw: m
  };
}
