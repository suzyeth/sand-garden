import { SandPlane } from './SandPlane';
import { SandBorder } from './SandBorder';
import { Stones } from './Stones';
import { MossPatches } from './MossPatches';
import { SandIsland } from './SandIsland';
import { BackWall } from './BackWall';
import { HomeStone } from './HomeStone';
import { Robot } from './Robot';
import { Butterfly } from './Butterfly';
import { Dragonflies } from './Dragonflies';
import { Gecko } from './Gecko';
import { Frog } from './Frog';
import { Sparrow } from './Sparrow';
import { Beetle } from './Beetle';
import { Weather } from './Weather';
import { RainSplashes } from './RainSplashes';
import { Periphery } from './Periphery';
import { StoneLantern } from './StoneLantern';
import { FallingLeaves } from './FallingLeaves';
import { Fireflies } from './Fireflies';
import { HOME_STONE_POS } from '../sim/stones';

/**
 * Top-level scene composition. The robot is purely kinematic so
 * none of these need physics bodies anymore - they're all plain
 * Three.js meshes/groups.
 */
export function Garden() {
  return (
    <>
      <SandPlane />
      <SandBorder />
      <BackWall />
      <MossPatches />
      <SandIsland />
      <Stones />
      <HomeStone position={[HOME_STONE_POS[0], 0.25, HOME_STONE_POS[1]]} />
      <Robot startPosition={[0, 0.4, 0]} />
      <Butterfly />
      <Dragonflies />
      <Gecko />
      <Frog />
      <Sparrow />
      <Beetle />
      <Weather />
      <RainSplashes />
      {/* Stone lantern tucked against the SW back-wall corner —
          diagonal opposite of the NE bamboo grove and pressed up
          against the L of the back + left walls. Sitting against
          the wall (~1m clearance) instead of free-standing in the
          quadrant keeps the SW 'ma' (negative sand space) intact
          while giving the lantern a structural anchor. */}
      <StoneLantern position={[-6.5, 0, -6.5]} scale={1} />
      <Periphery />
      <FallingLeaves />
      <Fireflies />
    </>
  );
}
