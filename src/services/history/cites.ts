const TOKEN = /\{c(\d+)\}/g;

/**
 * Message links are long (about 120 characters per message) and the tool results are resent in every later round, so the model
 * gets a short token like `{c3}` instead and the finished reply is expanded back into the ready-made `[date](<url>)` link.
 */
export class CiteRegistry {
    private links: string[] = [];
    private byLink = new Map<string, number>();

    /** Short token for a link; the same link always gets the same token. */
    add(link: string): string {
        let n = this.byLink.get(link);
        if (n === undefined) {
            this.links.push(link);
            n = this.links.length;
            this.byLink.set(link, n);
        }
        return `{c${n}}`;
    }

    /** Replaces tokens with their links; a token that was never issued is dropped. */
    expand(text: string): string {
        return text.replace(TOKEN, (_, n) => this.links[Number(n) - 1] ?? "");
    }
}
