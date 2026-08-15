import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ClientListener, CombinedController, Sp } from "./clientListener";

type VgrNotificationPacket = {
  customPacketType?: unknown;
  type?: unknown;
  message?: unknown;
  options?: unknown;
};

export class VgrNotificationService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let packet: VgrNotificationPacket;
    try {
      packet = JSON.parse(event.message?.contentJsonDump || "{}");
    } catch (_) {
      return;
    }

    if (packet.customPacketType !== "vgrNotification") return;

    const type = Number(packet.type) === 1 ? 1 : 2;
    const message = String(packet.message || "");
    const options = this.normalizeOptions(packet.options);

    this.sp.browser.executeJavaScript(
      "window.vgr_send_notification?.(" +
      JSON.stringify(type) + "," +
      JSON.stringify(message) + "," +
      JSON.stringify(options) +
      ");"
    );
  }

  private normalizeOptions(options: unknown): Record<string, unknown> {
    if (!options || typeof options !== "object" || Array.isArray(options)) return {};
    return options as Record<string, unknown>;
  }
}
