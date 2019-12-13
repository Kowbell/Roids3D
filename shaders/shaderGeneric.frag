varying highp vec3 v_fragmentColor;

void main(void) {
	gl_FragColor = vec4(v_fragmentColor, 1.0);
}