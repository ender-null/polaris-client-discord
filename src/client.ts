import WebSocket from 'ws';
import { Bot } from './bot';
import { WSMessage } from './types';
import { catchException, logger } from './utils';
import { Client, GatewayIntentBits, Message as DiscordMessage, Partials, Interaction, CacheType } from 'discord.js';

let bot: Bot;
let ws: WebSocket;
let pingInterval;

const close = () => {
  logger.warn(`Close server`);
  ws.terminate();
  process.exit();
};

process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
process.on('exit', () => {
  logger.warn(`Exit process`);
});

if (!process.env.SERVER || !process.env.DISCORD_TOKEN || !process.env.CONFIG) {
  if (!process.env.SERVER) {
    logger.warn(`Missing env variable SERVER`);
  }
  if (!process.env.CONFIG) {
    logger.warn(`Missing env variable CONFIG`);
  }
  if (!process.env.DISCORD_TOKEN) {
    logger.warn(`Missing env variable DISCORD_TOKEN`);
  }
  close();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.on('interactionCreate', async (interaction: Interaction<CacheType>) => {
  if (!interaction.isChatInputCommand()) return;
  const msg = await bot.convertInteraction(interaction);
  const data: WSMessage = {
    bot: 'polaris',
    platform: 'discord',
    type: 'message',
    message: msg,
  };
  ws.send(JSON.stringify(data));
});

client.on('messageCreate', async (message: DiscordMessage) => {
  const msg = await bot.convertMessage(message);
  const data: WSMessage = {
    bot: 'polaris',
    platform: 'discord',
    type: 'message',
    message: msg,
  };
  ws.send(JSON.stringify(data));
});

const poll = () => {
  logger.info('Starting polling...');
  ws = new WebSocket(process.env.SERVER);
  bot = new Bot(ws, client);
  client.user.setPresence({
    status: 'idle',
  });

  clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    bot.ping();
  }, 30000);

  ws.on('error', async (error: WebSocket.ErrorEvent) => {
    if (error['code'] === 'ECONNREFUSED') {
      logger.info(`Waiting for server to be available...`);
      setTimeout(poll, 5000);
    } else {
      logger.error(error);
    }
  });

  ws.on('open', async () => await bot.init());

  ws.on('close', (code) => {
    client.user.setPresence({
      status: 'dnd',
    });
    if (code === 1005) {
      logger.warn(`Disconnected`);
    } else if (code === 1006) {
      logger.warn(`Terminated`);
    }
    clearInterval(pingInterval);
    process.exit();
  });

  ws.on('message', async (data: string) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type !== 'pong') {
        logger.info(JSON.stringify(msg, null, 4));
      }
      if (msg.type === 'message') {
        await bot.sendMessage(msg.message);
      } else if (msg.type === 'command') {
        bot.handleCommand(msg);
      }
    } catch (error) {
      catchException(error);
    }
  });
};

client.on('ready', poll);

client.login(process.env.DISCORD_TOKEN);
