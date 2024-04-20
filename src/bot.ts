import WebSocket from 'ws';
import { Conversation, Extra, Message, User, WSBroadcast, WSInit, WSPing } from './types';
import { Config } from './config';
import { htmlToDiscordMarkdown, linkRegExp, logger, splitLargeMessage } from './utils';

import {
  ActivityType,
  AttachmentBuilder,
  CacheType,
  ChatInputCommandInteraction,
  Client,
  Message as DiscordMessage,
  EmbedBuilder,
} from 'discord.js';

export class Bot {
  user: User;
  config: Config;
  websocket: WebSocket;
  bot: Client;
  interactions: ChatInputCommandInteraction<CacheType>[];

  constructor(websocket: WebSocket, bot: Client) {
    this.websocket = websocket;
    this.bot = bot;
    this.interactions = [];
  }

  async init() {
    this.user = new User(
      this.bot.user.id,
      this.bot.user.globalName.length ? this.bot.user.globalName : this.bot.user.username,
      null,
      this.bot.user.discriminator != '0'
        ? `${this.bot.user.username}#${this.bot.user.discriminator}`
        : this.bot.user.username,
      this.bot.user.bot,
    );
    this.config = JSON.parse(process.env.CONFIG);
    this.bot.user.setPresence({
      status: 'online',
      activities: [
        {
          name: `${this.config.prefix}help`,
          type: ActivityType.Listening,
        },
      ],
    });
    const data: WSInit = {
      bot: this.user.username,
      platform: 'discord',
      type: 'init',
      user: this.user,
      config: this.config,
    };
    this.websocket.send(JSON.stringify(data, null, 4));
    logger.info(`Connected as @${data.user.username}`);
  }

  ping() {
    logger.debug('ping');
    const data: WSPing = {
      bot: this.user.username,
      platform: 'discord',
      type: 'ping',
    };
    this.websocket.send(JSON.stringify(data, null, 4));
  }

  broadcast(target: string | string[], chatId: string, content: string, type: string, extra?: Extra) {
    const data: WSBroadcast = {
      bot: this.user.username,
      platform: 'discord',
      type: 'broadcast',
      target: target,
      message: {
        conversation: new Conversation(chatId),
        content,
        type,
        extra,
      },
    };
    this.websocket.send(JSON.stringify(data, null, 4));
  }

  async convertMessage(msg: DiscordMessage) {
    const id = msg.id;
    const extra: Extra = {
      originalMessage: msg,
    };

    const conversation = new Conversation('-' + msg.channel.id);
    const sender = new User(
      msg.author.id,
      msg.author.globalName ? msg.author.globalName : msg.author.username,
      null,
      msg.author.discriminator != '0' ? `${msg.author.username}#${msg.author.discriminator}` : msg.author.username,
      msg.author.bot,
    );
    const reply = null;
    const content = msg.content;
    const type = 'text';
    const date = msg.createdTimestamp;
    const channel = await this.bot.channels.fetch(msg.channel.id);
    if (channel.constructor.name == 'DMChannel') {
      conversation.id = channel['recipient']['id'];
      conversation.title = channel['recipient']['username'];
    } else {
      conversation.title = channel['name'];
    }
    return new Message(id, conversation, sender, content, type, date, reply, extra);
  }

  async convertInteraction(msg: ChatInputCommandInteraction<CacheType>): Promise<Message> {
    const id = msg.id;
    const extra: Extra = {
      interaction: true,
    };
    const content = `${this.config.prefix}${msg.commandName}`;
    const type = 'text';
    const date = msg.createdTimestamp;
    const reply = null;
    const sender = new User(
      msg.user.id,
      msg.user.globalName ? msg.user.globalName : msg.user.username,
      null,
      msg.user.username,
      msg.user.bot,
    );
    const conversation = new Conversation('-' + msg.channel.id);
    const channel = await this.bot.channels.fetch(msg.channel.id);
    if (channel.constructor.name == 'DMChannel') {
      conversation.id = channel['recipientId'];
    }
    this.interactions.push(msg);
    return new Message(id, conversation, sender, content, type, date, reply, extra);
  }

  async sendMessage(msg: Message): Promise<void> {
    let interaction;
    if (msg.reply.extra.interaction) {
      interaction = this.interactions.find((interaction) => interaction.id === msg.reply.id);
      this.interactions.splice(this.interactions.indexOf(interaction), 1);
    }
    if (msg.content) {
      let chat;
      try {
        if (msg.extra.originalMessage) {
          chat = await this.bot.channels.fetch(msg.extra.originalMessage.channelId);
        } else if (String(msg.conversation.id).startsWith('-')) {
          chat = await this.bot.channels.fetch(String(msg.conversation.id).slice(1));
        } else {
          chat = await (await this.bot.users.fetch(String(msg.conversation.id))).dmChannel;
        }
      } catch (e) {
        logger.error(`${e.message} ${msg.conversation.id}`);
        return;
      }
      if (chat) {
        if (msg.type == 'text') {
          // let content = this.addDiscordMentions(msg.content);
          let content = msg.content;
          if (msg.extra) {
            if ('format' in msg.extra && msg.extra['format'] == 'HTML') {
              content = htmlToDiscordMarkdown(content);
            }
            if ('preview' in msg.extra && !msg.extra['preview']) {
              content = content.replace(linkRegExp, '<$&>');
            }
          }

          if (content.length > 2000) {
            const texts = splitLargeMessage(content, 2000);
            for (const text of texts) {
              if (interaction) {
                await interaction.reply(text);
              } else {
                await chat.send(text);
              }
            }
          } else {
            if (interaction) {
              await interaction.reply(content);
            } else {
              await chat.send(content);
            }
          }
        } else if (msg.type == 'photo' || msg.type == 'document' || msg.type == 'video' || msg.type == 'voice') {
          let sendContent = true;
          const embed = new EmbedBuilder();

          if (msg.extra && 'caption' in msg.extra && msg.extra['caption']) {
            const lines = msg.extra['caption'].split('\n');
            embed.setTitle(lines[0]);
            lines.splice(0, 1);
            embed.setDescription(lines.join('\n'));
            sendContent = false;
          }

          if (sendContent) {
            if (msg.content.startsWith('/') || msg.content.startsWith('C:\\')) {
              const file = new AttachmentBuilder(msg.content);
              if (interaction) {
                await interaction.reply({ files: [file] });
              } else {
                await chat.send({ files: [file] });
              }
            } else {
              if (interaction) {
                await interaction.reply(msg.content);
              } else {
                await chat.send(msg.content);
              }
            }
          } else {
            if (msg.content.startsWith('/') || msg.content.startsWith('C:\\')) {
              const file = new AttachmentBuilder(msg.content);
              await chat.send({ embeds: [embed], files: [file] });
            } else if (msg.content.startsWith('http')) {
              if (msg.type == 'photo') {
                embed.setImage(msg.content);
              }
            } else if (msg.type == 'video') {
              embed.setURL(msg.content);
            } else {
              embed.setURL(msg.content);
            }
            if (interaction) {
              await interaction.reply(embed);
            } else {
              await chat.send(embed);
            }
          }
        }
      }
    }
  }
}
