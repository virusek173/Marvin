import { Message } from "./openai";
import * as fs from "fs";

type Messages = Array<Message>;
type ContextMap = Record<string, Messages>;

export class ContextService {
    private contextMap: ContextMap;

    constructor(initContextMap: ContextMap) {
        this.contextMap = initContextMap;
    }

    ensureProperChannel(channelId?: string) {
        if (!channelId) {
            return 'global'
        }
        return channelId;
    }

    ensureChannelExists(channelId: string) {
        if (!this.contextMap[channelId]) {
            this.contextMap[channelId] = [];
        }
    }

    pushWithLimit(message: any, _channelId?: string, limit: number = 20) {
        const channelId = this.ensureProperChannel(_channelId);
        this.ensureChannelExists(channelId);
        const context = this.contextMap[channelId];
        if (context.length >= limit) {
            context.shift();
        }

        context.push(message);

        this.contextMap[channelId] = context;
    }

    setContext(contextMap: any, _channelId?: string) {
        const channelId = this.ensureProperChannel(_channelId);
        this.ensureChannelExists(channelId);
        this.contextMap[channelId] = contextMap;
    }

    getContext(_channelId?: string) {
        const channelId = this.ensureProperChannel(_channelId);
        this.ensureChannelExists(channelId);
        return this.contextMap[channelId];
    }

    loadContextFromFile = (fileName: string) => {
        try {
            if (fs.existsSync(fileName)) {
                const contextData = fs.readFileSync(fileName, "utf8");
                const contextMap = JSON.parse(contextData);

                this.setContextMap(contextMap);
            } else {
                this.setContextMap({});
            }
        } catch (error) {
            console.error("Error reading context file:", error);
            this.setContextMap({});
        }
    };

    saveContextToFile = (
        fileName: string,
    ): void => {
        try {
            const contextJson = JSON.stringify(this.contextMap, null, 2);
            fs.writeFileSync(fileName, contextJson);
        } catch (error) {
            console.error("Error writing context file:", error);
        }
    };

    getContextMap() {
        return this.contextMap;
    }

    setContextMap(contextMap: any) {
        this.contextMap = contextMap;
    }
}