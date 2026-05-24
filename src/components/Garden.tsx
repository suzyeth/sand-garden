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
import { Weather } from './Weather';
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
      <Weather />
      <StoneLantern position={[-5.8, 0, 5.4]} />
      <Periphery />
      <FallingLeaves />
      <Fireflies />
    </>
  );
}
