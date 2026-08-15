import { ClientListener, CombinedController, Sp } from "./clientListener";

interface VgrServerTime {
    anchor: { year: number; month: number; day: number; hour: number }; // month 1-12, year = in-game year (e.g. 201)
    anchorRealMs: number;
    timescale: number;
}

const kDaysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export class TimeService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on("update", () => this.onUpdate());
    }

    public getTime() {
        const serverTime = this.getServerTime();
        if (serverTime) {
            const target = this.computeServerTarget(serverTime);
            return { newGameHourValue: target.hour, date: new Date() };
        }

        const hoursOffsetSetting = this.sp.settings["skymp5-client"]["hoursOffset"];
        const hoursOffset = typeof hoursOffsetSetting === "number" ? hoursOffsetSetting : 0;
        const hoursOffsetMs = hoursOffset * 60 * 60 * 1000;

        const d = new Date(Date.now() + hoursOffsetMs);

        let newGameHourValue = 0;
        newGameHourValue += d.getUTCHours();
        newGameHourValue += d.getUTCMinutes() / 60;
        newGameHourValue += d.getUTCSeconds() / 60 / 60;
        newGameHourValue += d.getUTCMilliseconds() / 60 / 60 / 1000;
        return { newGameHourValue, date: d };
    }

    private getServerTime(): VgrServerTime | null {
        const value = this.sp.storage["vgrServerTime"] as Record<string, unknown> | undefined;
        if (!value || typeof value !== "object") return null;
        const anchor = value["anchor"] as Record<string, unknown> | undefined;
        if (!anchor) return null;
        if (typeof value["anchorRealMs"] !== "number") return null;
        if (typeof value["timescale"] !== "number" || value["timescale"] <= 0) return null;
        if (typeof anchor["hour"] !== "number" || typeof anchor["day"] !== "number"
            || typeof anchor["month"] !== "number" || typeof anchor["year"] !== "number") return null;
        return value as unknown as VgrServerTime;
    }
	
    private computeServerTarget(serverTime: VgrServerTime) {
        const elapsedRealHours = (Date.now() - serverTime.anchorRealMs) / 3600000;
        let hour = serverTime.anchor.hour + Math.max(0, elapsedRealHours) * serverTime.timescale;
        let day = serverTime.anchor.day;
        let month0 = Math.min(11, Math.max(0, Math.floor(serverTime.anchor.month) - 1));
        let year = serverTime.anchor.year;

        let extraDays = Math.floor(hour / 24);
        hour -= extraDays * 24;
        while (extraDays > 0) {
            const remainingInMonth = kDaysInMonth[month0] - day;
            if (extraDays <= remainingInMonth) {
                day += extraDays;
                extraDays = 0;
            } else {
                extraDays -= remainingInMonth + 1;
                day = 1;
                month0 += 1;
                if (month0 > 11) {
                    month0 = 0;
                    year += 1;
                }
            }
        }
        return { hour, day, month0, year };
    }

    private every2seconds() {
        const gameHourId = 0x38;
        const gameMonthId = 0x36;
        const gameDayId = 0x37;
        const gameYearId = 0x35;
        const timeScaleId = 0x3a;

        const gameHour = this.sp.GlobalVariable.from(this.sp.Game.getFormEx(gameHourId));
        const gameDay = this.sp.GlobalVariable.from(this.sp.Game.getFormEx(gameDayId));
        const gameMonth = this.sp.GlobalVariable.from(this.sp.Game.getFormEx(gameMonthId));
        const gameYear = this.sp.GlobalVariable.from(this.sp.Game.getFormEx(gameYearId));
        const timeScale = this.sp.GlobalVariable.from(this.sp.Game.getFormEx(timeScaleId));

        if (!gameHour || !gameDay || !gameMonth || !gameYear || !timeScale) {
            return;
        }

        const serverTime = this.getServerTime();
        if (serverTime) {
            const target = this.computeServerTarget(serverTime);
            const diff = Math.abs(gameHour.getValue() - target.hour);
            // resync on >= 1 in-game minute of drift
            if (diff >= 1 / 60) {
                gameHour.setValue(target.hour);
                gameDay.setValue(target.day);
                gameMonth.setValue(target.month0);
                gameYear.setValue(target.year);
            }
            timeScale.setValue(serverTime.timescale);
            return;
        }

        const { newGameHourValue, date } = this.getTime();

        const diff = Math.abs(gameHour.getValue() - newGameHourValue);

        if (diff >= 1 / 60) {
            gameHour.setValue(newGameHourValue);
            gameDay.setValue(date.getUTCDate());
            gameMonth.setValue(date.getUTCMonth());
            gameYear.setValue(date.getUTCFullYear() - 2020 + 199);
        }

        timeScale.setValue(gameHour.getValue() > newGameHourValue ? 0.6 : 1.2);
    }

    private onUpdate() {
        if (Date.now() - this.lastTimeUpd <= 2000) {
          return;
        }
        this.lastTimeUpd = Date.now();
        this.every2seconds();
    }

    private lastTimeUpd = 0;
}
