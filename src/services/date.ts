export class DateService {
    private date: Date;

    constructor(date?: Date | string | number) {
        this.date = date ? new Date(date) : new Date();
    }

    getFormattedDate() {
        var rr = this.date.getFullYear();
        var mm = this.date.getMonth() + 1;
        var dd = this.date.getDate();

        return [rr, (mm > 9 ? "" : "0") + mm, (dd > 9 ? "" : "0") + dd].join(".");
    }

    getFormattedDateTime() {
        const hh = this.date.getHours();
        const min = this.date.getMinutes();
        return `${this.getFormattedDate()} ${(hh > 9 ? "" : "0") + hh}:${(min > 9 ? "" : "0") + min}`;
    }
}