
uniform mat4 u_modelViewMatrix;  // Object local coords -> camera coords
uniform mat4 u_projectionMatrix; // camera coords -> camera space

attribute vec3 a_vertexPos;
attribute vec3 a_vertexCol;

varying vec3 v_fragmentColor;

void main(void) {
	gl_Position = u_projectionMatrix * u_modelViewMatrix * vec4(a_vertexPos, 1.0);
	v_fragmentColor = a_vertexCol;
}