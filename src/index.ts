import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    makeInMemoryStore,
    downloadContentFromMessage,
    MediaType,
    DownloadableMessage,
    WAMessage
} from "@whiskeysockets/baileys";
import { Sticker } from "wa-sticker-formatter";
import pino from "pino";

async function processMessage(context: WAMessage) {
    let retrievedMessage, buffer: Buffer, fileType: string;
    if (context.message.imageMessage) {
        retrievedMessage = context.message.imageMessage;
        fileType = "image";
    } else if (context.message.videoMessage) {
        retrievedMessage = context.message.videoMessage;
        fileType = "video";
    }

    if (retrievedMessage) {
        buffer = await downloadMessage(retrievedMessage, fileType as MediaType);
    }

    return buffer;
}

async function downloadMessage(message: DownloadableMessage, mediaType: MediaType) {
    let buffer = Buffer.from([]);

    try {
        const stream = await downloadContentFromMessage(message, mediaType)
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        return buffer;
    } catch (error) {
        console.log("Error downloading message", error);
        return null;
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const store = makeInMemoryStore({
        logger: pino().child({ level: "debug", stream: "store" }),
    });

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        getMessage: async (key) => (await store.loadMessage(key.remoteJid, key.id))?.message ?? undefined
    });

    store.bind(sock.ev);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close" && (lastDisconnect.error as Boom).output.statusCode !== DisconnectReason.loggedOut) {
            await connectToWhatsApp();
        } else if (connection === "open") {
            console.log("Connected to WhatsApp!");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const filteredMessages = messages.filter(
            (context) =>
                context.message &&
                !context.key.fromMe &&
                context.key.remoteJid.endsWith("@s.whatsapp.net")
        );

        for (const context of filteredMessages) {
            try {
                await processMessage(context).then(async (buffer) => {
                    if (!buffer) {
                        sock.sendMessage(
                            context.key.remoteJid,
                            { react: { text: "❌", key: context.key } },
                            { quoted: context }
                        );
                        return;
                    }

                    const sticker = await new Sticker(buffer, {
                        pack: "Figurinha criada por",
                        author: "@eiyaxz 🤖"
                    }).build();

                    sock.sendMessage(
                        context.key.remoteJid, 
                        { sticker }, 
                        { quoted: context }
                    );
                    
                    sock.sendMessage(
                        context.key.remoteJid,
                        { react: { text: "✅", key: context.key } },
                        { quoted: context }
                    );

                    console.info(`+${context.key.remoteJid.split('@')[0]} created a new sticker!`);
                });
            } catch (error) {
                console.log("Something went wrong.", error);
                sock.sendMessage(
                    context.key.remoteJid,
                    { react: { text: "❌", key: context.key } },
                    { quoted: context }
                );
            }
        }
    });
}

connectToWhatsApp();