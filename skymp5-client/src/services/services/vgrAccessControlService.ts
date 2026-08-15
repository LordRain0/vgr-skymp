import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ClientListener, CombinedController, Sp } from "./clientListener";

type VgrAccessControlPacket = {
  customPacketType?: unknown;
  event?: unknown;
  payload?: unknown;
};

const FRONTEND_FUNCTIONS: Record<string, string> = {
  showHint: "vgrAccessShowHint",
  hideHint: "vgrAccessHideHint",
  openContext: "vgrAccessOpenContext",
  openManage: "vgrAccessOpenManage",
  showSearchResults: "vgrAccessShowSearchResults",
};

export class VgrAccessControlService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let packet: VgrAccessControlPacket;
    try {
      packet = JSON.parse(event.message?.contentJsonDump || "{}");
    } catch (_) {
      return;
    }

    if (packet.customPacketType !== "vgrAccessControl") return;

    if (packet.event === "close") {
      this.sp.browser.executeJavaScript(
        'window.skyrimPlatform?.sendMessage?.("vgr:ui:close","access_control");'
      );
      return;
    }

    const frontendFunction = FRONTEND_FUNCTIONS[String(packet.event || "")];
    if (!frontendFunction) return;

    this.sp.browser.executeJavaScript(
      "window." + frontendFunction + "?.(" +
      JSON.stringify(this.normalizePayload(packet.payload)) +
      ");"
    );
  }

  private normalizePayload(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    return payload as Record<string, unknown>;
  }
}
