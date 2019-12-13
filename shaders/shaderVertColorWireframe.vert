
uniform mat4 u_modelViewMatrix;  // Object local coords -> camera coords
uniform mat4 u_projectionMatrix; // camera coords -> camera space

attribute vec3 a_vertexPos;
attribute vec3 a_vertexCol;
attribute vec3 a_baryCoords;
attribute vec3 a_wireframeColor;

varying vec3 v_fragmentColor;
varying vec3 v_baryCoords;
varying vec3 v_wireframeColor;
varying vec3 v_cameraDistance;

void main(void) {
	gl_Position = u_projectionMatrix * u_modelViewMatrix * vec4(a_vertexPos, 1.0);
	v_fragmentColor = a_vertexCol;
	v_baryCoords = a_baryCoords;
	v_wireframeColor = a_wireframeColor;

	// Holy Moly https://stackoverflow.com/a/16838219
	v_cameraDistance = vec3(gl_Position.w, gl_Position.w, gl_Position.w);

}