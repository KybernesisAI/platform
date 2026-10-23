import { magicHook } from "@kybernesis/magic/tools";

// Remembers which conversation each person last wrote in, so their heads-ups
// land there. Only verified people are recorded; magic's own turns are not.
export default magicHook();
