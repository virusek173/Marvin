import { Client, GatewayIntentBits } from "discord.js";

export class ClientService {
    private client: Client;

    constructor() {
        this.client = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        });
    }

    getClient(): any {
        return this.client;
    }
}