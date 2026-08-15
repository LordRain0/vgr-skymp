import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ClientListener, CombinedController, Sp } from "./clientListener";

type VgrPlayerInteractionsPacket = {
  customPacketType?: unknown;
  event?: unknown;
  payload?: unknown;
};

const FRONTEND_FUNCTIONS: Record<string, string> = {
  showPrompt: "vgrPlayerInteractionShowPrompt",
  openMenu: "vgrPlayerInteractionOpenMenu",
  openBindOptions: "vgrPlayerInteractionOpenBindOptions",
};

export class VgrPlayerInteractionsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let packet: VgrPlayerInteractionsPacket;
    try {
      packet = JSON.parse(event.message?.contentJsonDump || "{}");
    } catch (_) {
      return;
    }

    if (packet.customPacketType !== "vgrPlayerInteractions") return;

    if (packet.event === "closeMenu") {
      this.sp.browser.executeJavaScript(
        'window.skyrimPlatform?.sendMessage?.("vgr:ui:close","player_interaction");'
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
