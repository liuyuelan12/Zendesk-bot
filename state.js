// 会话状态：chatId ↔ ticketId / requesterId 的映射。
// 用一个 JSON 文件落盘，避免进程重启后丢失正在进行的工单会话。
// 不引数据库，本地最小可用即可。

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

// chatId(number) -> ticketId(number)
const chatToTicket = new Map();
// chatId(number) -> requesterId(number)（Zendesk end-user 的 id）
const chatToUserId = new Map();
// ticketId(number) -> 已转发过的最大 commentId（轮询去重用）
const ticketToLastComment = new Map();

// 从磁盘恢复状态。文件不存在或损坏时静默以空状态启动。
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    for (const [chatId, ticketId] of Object.entries(data.chatToTicket || {})) {
      chatToTicket.set(Number(chatId), ticketId);
    }
    for (const [chatId, userId] of Object.entries(data.chatToUserId || {})) {
      chatToUserId.set(Number(chatId), userId);
    }
    for (const [ticketId, commentId] of Object.entries(data.ticketToLastComment || {})) {
      ticketToLastComment.set(Number(ticketId), commentId);
    }
    console.log(`State loaded: ${chatToTicket.size} active conversation(s).`);
  } catch (error) {
    console.error('Failed to load state, starting fresh:', error.message);
  }
}

// 把当前状态写回磁盘。任何 set/delete 之后调用。
function saveState() {
  try {
    const data = {
      chatToTicket: Object.fromEntries(chatToTicket),
      chatToUserId: Object.fromEntries(chatToUserId),
      ticketToLastComment: Object.fromEntries(ticketToLastComment),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to save state:', error.message);
  }
}

// 建单后登记一条会话。
function setConversation(chatId, ticketId, userId) {
  chatToTicket.set(chatId, ticketId);
  chatToUserId.set(chatId, userId);
  saveState();
}

// 关单后清除一条会话。
function clearConversation(chatId) {
  const ticketId = chatToTicket.get(chatId);
  chatToTicket.delete(chatId);
  chatToUserId.delete(chatId);
  if (ticketId !== undefined) ticketToLastComment.delete(ticketId);
  saveState();
}

function getTicketId(chatId) {
  return chatToTicket.get(chatId);
}

function getUserId(chatId) {
  return chatToUserId.get(chatId);
}

// 轮询去重：取/存某工单已转发过的最大 commentId。
function getLastComment(ticketId) {
  return ticketToLastComment.get(ticketId) || 0;
}

function setLastComment(ticketId, commentId) {
  ticketToLastComment.set(ticketId, commentId);
  saveState();
}

// 轮询遍历用：当前所有活跃会话 [{chatId, ticketId, userId}]。
function getActiveConversations() {
  const list = [];
  for (const [chatId, ticketId] of chatToTicket.entries()) {
    list.push({ chatId, ticketId, userId: chatToUserId.get(chatId) });
  }
  return list;
}

module.exports = {
  loadState,
  setConversation,
  clearConversation,
  getTicketId,
  getUserId,
  getLastComment,
  setLastComment,
  getActiveConversations,
};
