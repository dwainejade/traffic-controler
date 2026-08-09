import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { SIGNAL } from "../art/palette";
import { junctionSize, type LevelDef } from "../sim/types";
import type { World } from "../sim/world";
import { selectJunction, useHud } from "../ui/hudStore";

/**
 * Click targets over each junction, plus a ring marking the one the player is
 * driving. With more than one junction the game's real constraint is attention:
 * you can only be at one of them at a time, so which one you're holding has to
 * be unmistakable.
 */
export function JunctionPicker({
  level,
  world,
}: {
  level: LevelDef;
  world: World;
}) {
  const selected = useHud((s) => s.selected);
  const linking = useHud((s) => s.linking);
  const linkSelection = useHud((s) => s.linkSelection);
  const ring = useRef<THREE.Mesh>(null);

  const junctions = useMemo(
    () =>
      level.nodes
        .filter((n) => n.kind === "junction")
        .map((n) => ({ id: n.id, pos: n.pos, size: junctionSize(level, n.id) })),
    [level],
  );

  const ringGeom = useMemo(
    () => new THREE.RingGeometry(0.9, 1, 56).rotateX(-Math.PI / 2),
    [],
  );

  useFrame(({ clock }) => {
    const mesh = ring.current;
    if (!mesh) return;

    const target = junctions.find((j) => j.id === selected);
    if (!target) {
      mesh.visible = false;
      return;
    }

    mesh.visible = true;
    // Breathe gently so the selection reads even when the map is busy.
    const pulse = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.02;
    const radius = (target.size / 2 + 5) * pulse;
    mesh.position.set(target.pos[0], 0.09, target.pos[1]);
    mesh.scale.set(radius, 1, radius);

    const junction = world.junctions.get(target.id);
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.color.set(
      junction?.state === "green"
        ? SIGNAL.green
        : junction?.state === "amber"
          ? SIGNAL.amber
          : SIGNAL.red,
    );
  });

  return (
    <group>
      {junctions.map((j) => (
        <mesh
          key={j.id}
          position={[j.pos[0], 0.04, j.pos[1]]}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
          onClick={(e) => {
            e.stopPropagation();
            selectJunction(j.id);
          }}
        >
          <planeGeometry args={[j.size + 14, j.size + 14]} />
        </mesh>
      ))}

      {/* While linking, every chosen junction gets its own marker so the group
          being assembled is visible on the map, not just in the panel. */}
      {linking &&
        junctions
          .filter((j) => linkSelection.includes(j.id))
          .map((j) => (
            <mesh
              key={`link-${j.id}`}
              geometry={ringGeom}
              position={[j.pos[0], 0.1, j.pos[1]]}
              scale={[j.size / 2 + 7, 1, j.size / 2 + 7]}
              renderOrder={3}
            >
              <meshBasicMaterial
                color="#2D8FD5"
                transparent
                opacity={0.95}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          ))}

      <mesh ref={ring} geometry={ringGeom} visible={false} renderOrder={2}>
        <meshBasicMaterial transparent opacity={0.9} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
