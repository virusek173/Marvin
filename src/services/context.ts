export class ContextService {
    private context: Array<any>;

    constructor(initContext: Array<any>) {
        this.context = initContext;
    }

    pushWithLimit(message: any, limit: number = 20) {
        if (this.context.length >= limit) {
            this.context.shift();
        }

        this.context.push(message);
    }

    setContext(context: any) {
        this.context = context;
    }

    getContext() {
        return this.context;
    }
}