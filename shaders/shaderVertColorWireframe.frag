precision mediump float; // set float to medium precision

varying vec3 v_fragmentColor;
varying vec3 v_baryCoords;
varying vec3 v_wireframeColor;
varying vec3 v_cameraDistance;

uniform sampler2D u_textureSampler;
uniform float u_wireframeThickness;

void main(void) {
	vec3 scaledThickness = u_wireframeThickness * v_cameraDistance;
	if (u_wireframeThickness > 0.0 && any(lessThan(v_baryCoords, scaledThickness))) {
		gl_FragColor = vec4(v_wireframeColor, 1);
	} else {
		gl_FragColor = vec4(v_fragmentColor, 1.0);
	}
}