import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ClientListener, CombinedController, Sp } from "./clientListener";

type VgrUiManagerPacket = {
  customPacketType?: unknown;
  action?: unknown;
  ui?: unknown;
};

export class VgrUiManagerService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let packet: VgrUiManagerPacket;
    try {
      packet = JSON.parse(event.message?.contentJsonDump || "{}");
    } catch (_) {
      return;
    }

    if (packet.customPacketType !== "vgrUiManager") return;

    const uiName = String(packet.ui || "").trim();
    if (!uiName) return;

    const message = packet.action === "open"
      ? "vgr:ui:open"
      : packet.action === "close"
        ? "vgr:ui:close"
        : "";
    if (!message) return;

    this.sp.browser.executeJavaScript(
      "window.skyrimPlatform?.sendMessage?.(" +
      JSON.stringify(message) + "," +
      JSON.stringify(uiName) +
      ");"
    );
  }
}
