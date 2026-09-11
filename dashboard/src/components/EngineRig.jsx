import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Procedural engine animation — driven live in Three.js from telemetry.engine.rpm.
const pad3 = (n) => String(n).padStart(3, '0');

const VISUAL_RPM_SCALE = 0.05;

const PISTON_GROUPS = [0, 1, 2, 3].map((i) => ({
  names: i === 0 ? ['piston', 'piston pin'] : [`piston.${pad3(i)}`, `piston pin.${pad3(i)}`],
  phase: i * 90,
}));

const VALVE_GROUPS = [0, 1, 2, 3].flatMap((i) => [
  { names: [i === 0 ? 'valve big' : `valve big.${pad3(i)}`], phase: i * 90 },
  { names: [i === 0 ? 'valve small' : `valve small.${pad3(i)}`], phase: i * 90 + 180 },
]);

const PUSHER_GROUPS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
  names: [i === 0 ? 'cam pusher' : `cam pusher.${pad3(i)}`],
  phase: (i % 4) * 90 + (i < 4 ? 0 : 180),
}));

const ROTATE_GROUPS = [
  { keyword: 'CRANK', ratio: 1 },
  { keyword: 'CAM SHAFT', ratio: 0.5 },
  { keyword: 'PROP GEAR', ratio: 0.42 },
  { keyword: 'FUEL PUMP GEAR', ratio: 0.5 },
  { keyword: 'FUEL IMPELLER', ratio: 0.5 },
  { keyword: 'WATER PUMP IMPELLER', ratio: 0.5 },
];

function getByExactNames(scene, names) {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const found = [];
  scene.traverse((obj) => {
    if (obj.isMesh && set.has((obj.name || '').toLowerCase())) found.push(obj);
  });
  return found;
}

function getByKeyword(scene, keyword) {
  const kw = keyword.toUpperCase();
  const found = [];
  scene.traverse((obj) => {
    if (obj.isMesh && (obj.name || '').toUpperCase().includes(kw)) found.push(obj);
  });
  return found;
}

// Corrected buildRig: Safely handles repeated calls and stores cleanup data
function buildRig(scene, meshes) {
  // Prevent React Strict Mode from double-rigging already processed meshes
  const unriggedMeshes = meshes.filter((m) => !m.userData.isRigged);
  if (!unriggedMeshes.length) return null;

  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  unriggedMeshes.forEach((m) => box.expandByObject(m));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  let axis;
  if (size.x >= size.y && size.x >= size.z) axis = new THREE.Vector3(1, 0, 0);
  else if (size.y >= size.x && size.y >= size.z) axis = new THREE.Vector3(0, 1, 0);
  else axis = new THREE.Vector3(0, 0, 1);

  const rig = new THREE.Group();
  rig.position.copy(center);
  scene.add(rig);
  scene.updateMatrixWorld(true);
  
  unriggedMeshes.forEach((m) => {
    m.userData.isRigged = true;
    m.userData.originalParent = m.parent; // Store original parent for clean unmounting
    rig.attach(m);
  });

  return { rig, axis, basePosition: center.clone(), axisSize: Math.max(size.x, size.y, size.z) };
}

export default function EngineRig({ scene, rpmRef }) {
  const rigsRef = useRef(null);
  const crankAngleRef = useRef(0);

  useEffect(() => {
    const rotate = ROTATE_GROUPS
      .map((cfg) => {
        const built = buildRig(scene, getByKeyword(scene, cfg.keyword));
        return built && { ...built, ratio: cfg.ratio };
      })
      .filter(Boolean);

    const piston = PISTON_GROUPS
      .map((cfg) => {
        const built = buildRig(scene, getByExactNames(scene, cfg.names));
        return built && { ...built, phase: cfg.phase };
      })
      .filter(Boolean);

    const valve = [...VALVE_GROUPS, ...PUSHER_GROUPS]
      .map((cfg) => {
        const built = buildRig(scene, getByExactNames(scene, cfg.names));
        return built && { ...built, phase: cfg.phase };
      })
      .filter(Boolean);

    rigsRef.current = { rotate, piston, valve };

    // Cleanup function to restore the scene graph if the component unmounts
    return () => {
      const allRigs = rigsRef.current;
      if (!allRigs) return;
      
      const { rotate, piston, valve } = allRigs;
      [...rotate, ...piston, ...valve].forEach(({ rig }) => {
        // Create a shallow copy of children since attach() modifies the array during iteration
        const children = rig.children.slice();
        children.forEach((m) => {
          if (m.userData.originalParent) {
            m.userData.originalParent.attach(m);
          }
          m.userData.isRigged = false;
        });
        rig.removeFromParent();
      });
    };
  }, [scene]);

  useFrame((state, delta) => {
    const rigs = rigsRef.current;
    if (!rigs) return;

    const rpm = Number(rpmRef?.current);
    if (!Number.isFinite(rpm)) return;

    const visualRevPerSec = (Math.max(0, rpm) * VISUAL_RPM_SCALE) / 60;
    const deltaAngle = visualRevPerSec * 2 * Math.PI * delta;
    
    crankAngleRef.current += deltaAngle;
    const crankAngle = crankAngleRef.current;
    const camAngleDeg = THREE.MathUtils.radToDeg(crankAngle / 2);

    // Continuous spin for rotational parts
    rigs.rotate.forEach(({ rig, axis, ratio }) => {
      rig.rotateOnWorldAxis(axis, deltaAngle * ratio);
    });

    // Piston reciprocation
    rigs.piston.forEach(({ rig, axis, basePosition, axisSize, phase }) => {
      const amplitude = axisSize * 0.18;
      const offset = amplitude * Math.sin(crankAngle + THREE.MathUtils.degToRad(phase));
      rig.position.set(
        basePosition.x + axis.x * offset,
        basePosition.y + axis.y * offset,
        basePosition.z + axis.z * offset
      );
    });

    // Valve and lifter pulsation
    rigs.valve.forEach(({ rig, axis, basePosition, axisSize, phase }) => {
      const amplitude = axisSize * 0.12;
      const angleRad = THREE.MathUtils.degToRad(camAngleDeg - phase);
      const lift = amplitude * Math.pow(Math.max(0, Math.cos(angleRad)), 8);
      rig.position.set(
        basePosition.x + axis.x * lift,
        basePosition.y + axis.y * lift,
        basePosition.z + axis.z * lift
      );
    });
  });

  return null;
}