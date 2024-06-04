import WebSocket from 'ws';
import {
  Command,
  Conversation,
  Extra,
  Message,
  ParameterType,
  User,
  WSBroadcast,
  WSCommand,
  WSInit,
  WSPing,
} from './types';
import { Config } from './config';
import { fromBase64, htmlToDiscordMarkdown, linkRegExp, logger, splitLargeMessage } from './utils';

import {
  ActivityType,
  ApplicationCommand,
  AttachmentBuilder,
  CacheType,
  ChatInputCommandInteraction,
  Client,
  Collection,
  Message as DiscordMessage,
  EmbedBuilder,
  GuildResolvable,
  REST,
  Routes,
} from 'discord.js';

export class Bot {
  user: User;
  config: Config;
  websocket: WebSocket;
  bot: Client;
  messages: DiscordMessage[];
  interactions: ChatInputCommandInteraction<CacheType>[];
  commands: Collection<
    string,
    ApplicationCommand<{
      guild: GuildResolvable;
    }>
  >;

  constructor(websocket: WebSocket, bot: Client) {
    this.websocket = websocket;
    this.bot = bot;
    this.messages = [];
    this.interactions = [];
  }

  async init() {
    this.user = new User(
      this.bot.user.id,
      this.bot.user.globalName ? this.bot.user.globalName : this.bot.user.username,
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
          state: `✨ ${this.config.prefix}help`,
          type: ActivityType.Custom,
        },
      ],
    });
    this.commands = await this.bot.application.commands.fetch();
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
    if (this.user) {
      const data: WSPing = {
        bot: this.user.username,
        platform: 'discord',
        type: 'ping',
      };
      this.websocket.send(JSON.stringify(data, null, 4));
    }
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
    this.messages.push(msg);
    return new Message(id, conversation, sender, content, type, date, reply, extra);
  }

  async convertInteraction(msg: ChatInputCommandInteraction<CacheType>): Promise<Message> {
    const id = msg.id;
    const extra: Extra = {
      interaction: true,
    };
    let content = `${this.config.prefix}${msg.commandName}`;
    if (msg.options.data.length) {
      for (const param of msg.options.data) {
        content += ' ' + param.value;
      }
    }
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
    const channelId = msg.channelId || msg.channel.id;
    const conversation = new Conversation('-' + channelId, channelId);
    try {
      const channel = await this.bot.channels.fetch(channelId);
      if (channel.constructor.name == 'DMChannel') {
        conversation.id = channel['recipientId'];
      }
    } catch (error) {
      logger.error(error.message);
    }
    this.interactions.push(msg);
    return new Message(id, conversation, sender, content, type, date, reply, extra);
  }

  async sendMessage(msg: Message): Promise<void> {
    let message: DiscordMessage;
    let interaction: ChatInputCommandInteraction<CacheType>;
    if (msg.reply.extra.interaction) {
      interaction = this.interactions.find((interaction) => interaction.id === msg.reply.id);
      this.interactions.splice(this.interactions.indexOf(interaction), 1);
    } else {
      message = this.messages.find((message) => message.id === msg.reply.id);
      this.messages.splice(this.messages.indexOf(message), 1);
    }
    if (msg.content) {
      let channel: any;
      try {
        if (msg.extra.originalMessage) {
          channel = await this.bot.channels.fetch(msg.extra.originalMessage.channelId);
        } else if (String(msg.conversation.id).startsWith('-')) {
          channel = await this.bot.channels.fetch(String(msg.conversation.id).slice(1));
        } else {
          channel = await (await this.bot.users.fetch(String(msg.conversation.id))).dmChannel;
        }
      } catch (e) {
        logger.error(`${e.message} ${msg.conversation.id}`);
        return;
      }
      if (msg.type == 'text') {
        let content = msg.content;
        if (msg.extra) {
          if (msg.extra.preview !== undefined && !msg.extra.preview) {
            content = content.replace(linkRegExp, '<$&>');
          }
          if (msg.extra.format == 'HTML') {
            content = htmlToDiscordMarkdown(content);
          }
          if (msg.reply.extra.interaction && content.indexOf(this.config.prefix) > -1) {
            content = this.addDiscordSlashCommands(content);
          }
        }

        let texts = [content];
        if (content.length > 2000) {
          texts = splitLargeMessage(content, 2000);
        }
        let replied = false;
        for (const text of texts) {
          const params = {
            content: text,
            allowedMentions: {
              repliedUser: false,
            },
          };
          if (interaction) {
            if (!replied) {
              await interaction.reply({ ...params });
              replied = true;
            } else {
              await interaction.followUp({ ...params });
            }
          } else if (message) {
            await message.reply({ ...params });
          } else if (channel) {
            await channel.send({ ...params });
          }
        }
      } else if (msg.type == 'photo' || msg.type == 'document' || msg.type == 'video' || msg.type == 'voice') {
        const embed = new EmbedBuilder();
        let skipEmbed = true;
        let params: any = {
          content: msg.content,
          allowedMentions: {
            repliedUser: false,
          },
        };

        if (msg.extra && msg.extra.caption) {
          let caption = msg.extra.caption;
          if (msg.extra.format == 'HTML') {
            caption = htmlToDiscordMarkdown(caption);
          }
          const lines = caption.split('\n');
          embed.setTitle(lines[0]);
          lines.splice(0, 1);
          embed.setDescription(lines.join('\n'));
          skipEmbed = false;
        }

        if (msg.content.startsWith('/') || msg.content.startsWith('C:\\')) {
          const file = await fromBase64(msg.content);
          const attachment = new AttachmentBuilder(file.name);
          params = { ...params, embeds: !skipEmbed ? [embed] : null, files: [attachment] };
        } else if (msg.content.startsWith('http')) {
          if (msg.type == 'photo') {
            embed.setImage(msg.content);
          } else {
            embed.setURL(msg.content);
          }
        } else {
          params = {
            ...params,
            embeds: !skipEmbed ? [embed] : null,
            content: skipEmbed ? msg.content : null,
          };
        }
        console.log(params);
        if (params) {
          if (interaction) {
            await interaction.reply({ ...params });
          } else if (message) {
            await message.reply({ ...params });
          } else if (channel) {
            await channel.send({ ...params });
          }
        }
      }
    }
  }

  async handleCommand(msg: WSCommand): Promise<void> {
    if (msg.method === 'setCommands') {
      const commands: any[] = (msg.payload.commands as any[]).map((command: Command) => {
        return {
          name: command.command,
          description: command.description,
          type: 1,
          integration_types: [0, 1],
          options: command.parameters?.map((param) => {
            return {
              name: param.name.replace(/\s/gim, '_'),
              description: param.name,
              required: param.required,
              type: this.getParameterType(param.type),
            };
          }),
        };
      });

      const rest = new REST({ version: '10' }).setToken(this.config.apiKeys.discordBotToken);
      await rest.put(Routes.applicationCommands(this.config.apiKeys.discordClientId.toString()), { body: commands });
    } else {
      logger.error('Unsupported method');
    }
  }

  getParameterType(type: ParameterType): number {
    if (type === 'integer') {
      return 4;
    } else if (type === 'boolean') {
      return 5;
    } else if (type === 'user') {
      return 6;
    } else if (type === 'number') {
      return 10;
    }
    return 3;
  }

  addDiscordSlashCommands(content: string): string {
    const prefix = this.config.prefix.replace(/[.*+?^$!/{}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${prefix}\\S+`, 'gim');
    const matches = content.match(regex);
    if (matches) {
      for (const match of matches) {
        const command = this.commands.find((command) => command.name === match.slice(1));
        if (command) {
          const matchRegex = new RegExp(`(?<!<)${prefix}${match.slice(1)}\\s(?!:)`, 'gim');
          content = content.replace(matchRegex, `</${command.name}:${command.id}> `);
        }
      }
    }
    return content;
  }
}
