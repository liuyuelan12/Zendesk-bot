require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const zendesk = require('node-zendesk');
const express = require('express');
const state = require('./state');
const { startPolling } = require('./poller');
const app = express();

// 启动时校验必需的环境变量，缺哪个就明确报哪个，避免后续抛出难懂的底层错误。
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'ZENDESK_EMAIL', 'ZENDESK_TOKEN', 'ZENDESK_SUBDOMAIN'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('❌ 缺少必需的环境变量：' + missingEnv.join(', '));
  console.error('请在 .env 中填写后再启动（参考 README.md）。');
  process.exit(1);
}

// /close 时写回的「问题类型」自定义字段 ID。绑定具体 Zendesk 实例，抽到 env；未配置则跳过该字段。
const QTYPE_FIELD_ID = process.env.ZENDESK_QTYPE_FIELD_ID
  ? Number(process.env.ZENDESK_QTYPE_FIELD_ID)
  : null;

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// 处理轮询错误（双实例 / token 错误会刷 409 Conflict），否则会静默吞掉。
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

// Initialize Zendesk Client
const zendeskClient = zendesk.createClient({
  username: process.env.ZENDESK_EMAIL,
  token: process.env.ZENDESK_TOKEN,
  remoteUri: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`
});

// 从磁盘恢复正在进行的会话（chatId ↔ ticket / requester）。
state.loadState();

// 启动轮询回传：定时把客服在工单里的新公开回复转发给对应 Telegram 用户。
startPolling({
  bot,
  zendeskClient,
  state,
  intervalMs: Number(process.env.POLL_INTERVAL_MS) || 8000,
});

// Express middleware
app.use(express.json());

// Handle /start command
bot.onText(/\/start/i, async (msg) => {
  const chatId = msg.chat.id;
  // 只在私聊中响应
  if (msg.chat.type !== 'private') return;
  bot.sendMessage(chatId, 
    'Welcome to SuperEx Support! 👋\n\n' +
    'Use /ticket to create a new support ticket\n' +
    'Use /close to close your current ticket'
  );
});

// Handle /ticket command
bot.onText(/\/ticket/i, async (msg) => {
  const chatId = msg.chat.id;
  // 只在私聊中响应
  if (msg.chat.type !== 'private') return;

  // Check if user already has an active ticket
  if (state.getTicketId(chatId)) {
    bot.sendMessage(chatId, 'You already have an active ticket. Please close it with /close before creating a new one.');
    return;
  }

  try {
    // Create a new ticket in Zendesk
    // Get user information
    const userDisplayName = msg.from.username || msg.from.first_name || `User_${msg.from.id}`;

    // Try to find existing user first
    const userEmail = `${msg.from.id}@telegram.bot`;
    let endUser;
    try {
      const searchResult = await zendeskClient.users.search({ query: userEmail });
      endUser = searchResult[0] || await zendeskClient.users.create({
        user: {
          name: userDisplayName,
          email: userEmail,
          role: 'end-user'
        }
      });
    } catch (searchError) {
      console.error('Error searching for user:', searchError);
      // If search fails, try to create user directly
      endUser = await zendeskClient.users.create({
        user: {
          name: userDisplayName,
          email: userEmail,
          role: 'end-user'
        }
      });
    }

    // Create the ticket with correct submitter and requester
    const ticket = await zendeskClient.tickets.create({
      ticket: {
        subject: `Support Request from ${userDisplayName}`,
        comment: {
          body: 'User started a new support conversation',
          author_id: endUser.id
        },
        requester_id: endUser.id,
        submitter_id: endUser.id,
        tags: ['telegram']
      }
    });

    // Get the requester ID from the created ticket
    const requesterId = ticket.requester_id;

    // Store both ticket ID and requester ID（落盘，重启不丢）
    state.setConversation(chatId, ticket.id, requesterId);
    bot.sendMessage(chatId,
      `Support ticket #${ticket.id} has been created. Our team will assist you shortly.\n\n` +
      'You can send messages here and they will be added to your support ticket.\n' +
      'To close your current ticket, simply send /close command.'
    );
  } catch (error) {
    console.error('Error:', error);
    if (error.result) {
      console.error('Detailed error:', error.result.toString());
    }
    bot.sendMessage(chatId, 'Sorry, there was an error creating your support ticket.');
  }
});

// Handle /close command
bot.onText(/\/close/i, async (msg) => {
  const chatId = msg.chat.id;
  // 只在私聊中响应
  if (msg.chat.type !== 'private') return;
  const ticketId = state.getTicketId(chatId);

  if (ticketId) {
    try {
      // 提供问题类型选项
      const keyboard = {
        inline_keyboard: [
          [
            { text: 'General Inquiry', callback_data: 'close_general' },
            { text: 'Technical Issue', callback_data: 'close_technical' }
          ],
          [
            { text: 'Account Issue', callback_data: 'close_account' },
            { text: 'Other', callback_data: 'close_other' }
          ]
        ]
      };

      bot.sendMessage(chatId, 'Please select a reason to close your ticket:', { reply_markup: keyboard });
    } catch (error) {
      console.error('Error:', error);
      bot.sendMessage(chatId, 'Sorry, there was an error closing your ticket.');
    }
  } else {
    bot.sendMessage(chatId, 'You don\'t have an active support ticket. Send /start to create one.');
  }
});

// Handle close ticket callback
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const ticketId = state.getTicketId(chatId);
  const data = callbackQuery.data;

  if (data.startsWith('close_') && ticketId) {
    try {
      // Map callback data to question type
      const questionTypeMap = {
        'close_general': 'chat',  // 一般咨询
        'close_technical': 'abnormal_problem',  // 技术问题
        'close_account': 'account_issues',  // 账户问题
        'close_other': 'deposit_and_withdrawal_problem'  // 其他
      };

      const questionTypeTag = questionTypeMap[data];
      const questionTypeDisplay = {
        'chat': 'General Inquiry',
        'abnormal_problem': 'Technical Issue',
        'account_issues': 'Account Issue',
        'deposit_and_withdrawal_problem': 'Other'
      }[questionTypeTag];

      // Update ticket with question type and solve it
      const updatePayload = {
        ticket: {
          status: 'solved',
          comment: {
            body: `User closed the conversation (Type: ${questionTypeDisplay})`,
            public: false,
            author_id: state.getUserId(chatId)
          }
        }
      };
      // 仅当配置了字段 ID 时才写「问题类型」，避免在没有该字段的实例上报错。
      if (QTYPE_FIELD_ID) {
        updatePayload.ticket.custom_fields = [{ id: QTYPE_FIELD_ID, value: questionTypeTag }];
      }
      await zendeskClient.tickets.update(ticketId, updatePayload);

      // Answer callback query and send success message
      await bot.answerCallbackQuery(callbackQuery.id);
      state.clearConversation(chatId);
      bot.sendMessage(chatId, 
        'Your support ticket has been closed. 🎉\n\n' +
        'If you need help again, just send /start to create a new ticket.'
      );
    } catch (error) {
      console.error('Error:', error);
      if (error.result) {
        console.error('Error details:', error.result.toString());
      }
      bot.sendMessage(chatId, 'Sorry, there was an error closing your ticket.');
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Error closing ticket'
      });
    }
  } else {
    await bot.answerCallbackQuery(callbackQuery.id);
    if (!ticketId) {
      bot.sendMessage(chatId, 'You don\'t have an active support ticket. Send /start to create one.');
    }
  }
});

// Handle regular messages
bot.on('message', async (msg) => {
  // 只在私聊中响应
  if (msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const messageText = msg.text;

  // 非文本消息（图片/贴纸/文件等）没有 text，直接忽略，避免把 undefined 写进工单。
  if (!messageText) {
    return;
  }

  // Ignore commands
  if (messageText.startsWith('/')) {
    return;
  }

  try {
    // Check if there's an existing ticket for this user
    const ticketId = state.getTicketId(chatId);

    if (!ticketId) {
      bot.sendMessage(chatId, 'Please use /ticket to create a new support ticket first.');
    } else {
      // Add comment to existing ticket as the user
      await zendeskClient.tickets.update(ticketId, {
        ticket: {
          comment: {
            body: messageText,
            public: true,
            author_id: state.getUserId(chatId),  // Use the user's ID
            type: 'Comment',  // Specify this is a regular comment
            via: { channel: 'telegram' }  // Mark the source as telegram
          }
        }
      });
      // Don't echo user's message back to avoid duplication
    }
  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, 'Sorry, there was an error processing your message.');
  }
});

// 健康检查端点（Render 等平台的 web 服务需要进程绑定一个端口）。
// 客服回复的回传走轮询（见 poller.js），不再需要 webhook 入口。
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// Start the server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
