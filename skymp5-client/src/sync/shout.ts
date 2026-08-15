import { Actor, Game, Shout, WordOfPower, printConsole } from 'skyrimPlatform';

export const learnShouts = (actor: Actor, shoutIds: Array<number>) => {
  for (const shoutId of shoutIds) {
    const shout = Shout.from(Game.getFormEx(shoutId));

    if (shout) {
      const addResult = actor.addShout(shout);
      printConsole(
        `addResult: ${addResult}, shoutIdToLearn: ${shout
          .getFormID()
          .toString(16)}, shoutName: ${shout.getName()}`,
      );
    }
  }
};

export const unlockWords = (wordIds: Array<number>) => {
  for (const wordId of wordIds) {
    const word = WordOfPower.from(Game.getFormEx(wordId));

    if (word) {
      Game.unlockWord(word);
      printConsole(
        `wordIdToUnlock: ${word.getFormID().toString(16)}, wordName: ${word.getName()}`,
      );
    }
  }
};
