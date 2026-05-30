// 轮询回传(B 链路):定时拉每个活跃工单的评论,把客服的新公开回复转发给对应的 Telegram 用户。
// 用轮询而非 webhook —— 无需公网地址、无需在 Zendesk 后台配触发器。

// 客服名字缓存:authorId -> name。客服少、名字基本不变,避免每条评论都打一次 users API。
const agentNameCache = new Map();

// 取客服显示名,带缓存;取不到时回退 'Support Team'。
async function resolveAuthorName(zendeskClient, authorId) {
  if (agentNameCache.has(authorId)) return agentNameCache.get(authorId);
  try {
    const user = await zendeskClient.users.show(authorId);
    const name = (user && user.name) || 'Support Team';
    agentNameCache.set(authorId, name);
    return name;
  } catch (error) {
    return 'Support Team';
  }
}

// 处理单个工单:转发该工单里"客服新发的公开回复"给指定 chatId。
async function pollOneTicket({ bot, zendeskClient, state }, { chatId, ticketId, userId }) {
  const comments = await zendeskClient.tickets.getComments(ticketId);
  if (!Array.isArray(comments) || comments.length === 0) return;

  const lastSeen = state.getLastComment(ticketId);
  let maxId = lastSeen;

  // 只转发:公开 + 非用户本人作者(即客服)+ 比上次转发的更新。按 id 升序保证顺序。
  const toForward = comments
    .filter((c) => c.public === true && c.author_id !== userId && c.id > lastSeen)
    .sort((a, b) => a.id - b.id);

  for (const c of comments) {
    if (c.id > maxId) maxId = c.id;
  }

  for (const c of toForward) {
    const agentName = await resolveAuthorName(zendeskClient, c.author_id);
    await bot.sendMessage(chatId, `👤 Support Agent (${agentName}):\n${c.body}`);
  }

  // 推进游标到本轮见到的最大评论 id(含用户消息),下轮不再重复扫。
  if (maxId > lastSeen) state.setLastComment(ticketId, maxId);
}

// 跑一轮:遍历所有活跃会话。单个工单出错只记录并跳过,不影响其它工单。
async function pollOnce(deps) {
  const conversations = deps.state.getActiveConversations();
  for (const conv of conversations) {
    if (conv.userId === undefined) continue; // 异常会话,跳过
    try {
      await pollOneTicket(deps, conv);
    } catch (error) {
      console.error(`Poll error for ticket ${conv.ticketId}:`, error.message);
    }
  }
}

// 启动轮询。用递归 setTimeout 而非 setInterval,避免上一轮未结束就叠下一轮。
function startPolling({ bot, zendeskClient, state, intervalMs }) {
  const deps = { bot, zendeskClient, state };
  const tick = async () => {
    await pollOnce(deps);
    setTimeout(tick, intervalMs);
  };
  console.log(`Polling Zendesk every ${intervalMs}ms for agent replies.`);
  setTimeout(tick, intervalMs);
}

module.exports = { startPolling };
