import {
  Form,
  FormType,
  isPickupableItem as nativeIsPickupableItem,
} from "skyrimPlatform";

export class FormTypeEx {
  static isItem(form: Form | null | undefined) {
    if (!form) {
      return false;
    }

    const type = form.getType();
    if (type === FormType.Light) {
      return nativeIsPickupableItem(form.getFormID());
    }

    return FormTypeEx.simpleItemTypes.has(type);
  }

  static isPickupableItem(form: Form | null | undefined) {
    return this.isItem(form);
  }

  private static readonly simpleItemTypes = new Set<number>([
    FormType.Ammo,
    FormType.Armor,
    FormType.Book,
    FormType.Ingredient,
    FormType.Potion,
    FormType.ScrollItem,
    FormType.SoulGem,
    FormType.Weapon,
    FormType.Misc,
  ]);
}
