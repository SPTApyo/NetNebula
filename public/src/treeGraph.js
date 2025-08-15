// src/treeGraph.js
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Crée un graphique 3D à partir des sites et de leurs liens
 * @param {Array} sites
 */
export function createTreeGraph(sites) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);

  // Création des noeuds
  const nodeGeometry = new THREE.SphereGeometry(0.5, 32, 32);
  const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  const nodes = {};

  sites.forEach((site, index) => {
    const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
    node.position.set(Math.random()*10-5, Math.random()*10-5, Math.random()*10-5);
    scene.add(node);
    nodes[site.name] = node;
  });

  // Création des liens
  const linkMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
  sites.forEach(site => {
    if (!site.links) return;
    site.links.forEach(linkName => {
      if (nodes[linkName]) {
        const points = [];
        points.push(nodes[site.name].position);
        points.push(nodes[linkName].position);
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, linkMaterial);
        scene.add(line);
      }
    });
  });

  camera.position.z = 20;

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  animate();
}
