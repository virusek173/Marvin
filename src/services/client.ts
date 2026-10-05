import { Client, GatewayIntentBits, Partials } from "discord.js";

export class ClientService {
    private client: Client;

    constructor() {
        this.client = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
            // Without partials Discord.js drops reaction events on messages that are not in its cache (anything older than the last restart).
            partials: [Partials.Message, Partials.Reaction, Partials.Channel],
        });
    }

    getClient(): any {
        return this.client;
    }
}
