// GLSL snippet injected into LineMaterial's fragment shader via onBeforeCompile.
// The pre-existing vColor (vertex color from gradient) is multiplied by an audio-driven glow.
// See BuildingsLayer.ts for the injection points (lookup: "BUILDING_FRAG_INJECT").

// uniform float uAudioGlow;   // injected via uniforms hook
// uniform float uTrebleBoost; // injected via uniforms hook

// Replacement for the final color expression — multiplied with whatever LineMaterial computed.
// vec3 finalColor = vColor.rgb * (1.0 + uAudioGlow * 0.8 + uTrebleBoost * 1.2);
// gl_FragColor = vec4(finalColor, vColor.a);
