/**
 * 大模型转发代理（Cloudflare Pages Functions）
 *
 * 职责只有三件：
 *   1. 把浏览器发来的完整提示词转给 DeepSeek
 *   2. 转发时补上 Authorization: Bearer <API_KEY>（key 存加密环境变量，不进仓库）
 *   3. 把结果原样返回
 *
 * 服务器【完全不懂业务】—— 不知道什么是检索、什么是制度、什么是年报。
 * 检索全部在浏览器本地完成，这里只是一个带钥匙的转发器。
 */
export async function onRequestPost({ request, env }) {
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: '服务端未配置 API Key' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }

  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages 不能为空' }, 400);
  }
  // 只允许一问一答的上限，避免被当作通用接口滥用
  if (JSON.stringify(messages).length > 60000) {
    return json({ error: '请求过大' }, 413);
  }

  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

  let upstream;
  try {
    upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'deepseek-chat',
        messages,
        temperature: 0,
        max_tokens: 900,
      }),
    });
  } catch (e) {
    return json({ error: '上游连接失败：' + String(e).slice(0, 120) }, 502);
  }

  if (!upstream.ok) {
    const t = await upstream.text();
    return json({ error: '上游 ' + upstream.status + '：' + t.slice(0, 300) }, 502);
  }

  const data = await upstream.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return json({ text });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
