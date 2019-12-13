export const name = 'modelTypes';


/** @typedef {number[]} vec3 [x, y, z] */
var vec3 = glMatrix.vec3;
/** @typedef {number[]} vec4 [x, y, z, w] */
var vec4 = glMatrix.vec4;
/** @typedef {number[]} vec4 [x, y, z, w] */
var quat = glMatrix.quat;
/** @typedef {number[]} mat4 16-component 1D matrix, column-major */
var mat4 = glMatrix.mat4;

function degToRad(d) { return d * Math.PI / 180; }


/**
 * Information loaded from triangle files at init time
 * This never changes
 */
export class ModelData {
	constructor (inVertArray, inColorArray, inIndexArray) {
		this.vertArray = inVertArray;
		this.colorArray = inColorArray;
		this.indexArray = inIndexArray;
	} // ctor
} // class ModelData

/**
 * Translation/Scale vec3's and rotation quaternion
 * Matrix is computed from these + the camera view matrix
 * Rotation is in degrees!
 */
export class Transform {
	constructor () {
		this.transVec3 = vec3.fromValues(0, 0, 0);
		this.scaleVec3 = vec3.fromValues(1, 1, 1);
		this.rotVec3   = vec3.fromValues(0, 0, 0);
	} // ctor()

	/**
	 * Scale --> rotate --> translate
	 * https://gamedev.stackexchange.com/a/16721
	 * But for math reasons... it's really translate -> rotate -> scale...?
	 * ¯\_(ツ)_/¯
	 * @return mat4
	 */
	computeMatrix() {
		// Set up...
		var out = mat4.create();

		mat4.translate(out, out, this.transVec3);

		mat4.rotateX(out, out, degToRad(this.rotVec3[0]));
		mat4.rotateY(out, out, degToRad(this.rotVec3[1]));
		mat4.rotateZ(out, out, degToRad(this.rotVec3[2]));
		
		mat4.scale(out, out, this.scaleVec3);
		// Done!
		return out;
	} // computeMatrix()
} // class Transform

/**
 * Vertex, Color, and Triangle buffers for a drawable
 * Based on ModelData, so this is loaded at init and likely never changes
 */
export class DrawableBuffers {
	constructor (inWebGL, inModelData) {
		this.vertexBuffer = inWebGL.createBuffer();
		inWebGL.bindBuffer(inWebGL.ARRAY_BUFFER, this.vertexBuffer);
		inWebGL.bufferData(inWebGL.ARRAY_BUFFER, new Float32Array(inModelData.vertArray), inWebGL.STATIC_DRAW);

		this.colorBuffer = inWebGL.createBuffer();
		inWebGL.bindBuffer(inWebGL.ARRAY_BUFFER, this.colorBuffer);
		inWebGL.bufferData(inWebGL.ARRAY_BUFFER, new Float32Array(inModelData.colorArray), inWebGL.STATIC_DRAW);

		this.triangleBuffer = inWebGL.createBuffer();
		inWebGL.bindBuffer(inWebGL.ELEMENT_ARRAY_BUFFER, this.triangleBuffer); 
		inWebGL.bufferData(inWebGL.ELEMENT_ARRAY_BUFFER, new Uint16Array(inModelData.indexArray), inWebGL.STATIC_DRAW);
		this.triangleBufferLength = inModelData.indexArray.length;
	} // ctor
} // class DrawableBuffers

export class Drawable {
	constructor (inWebGL, inModelData) {
		this.modelData = inModelData;
		this.transform = new Transform();
		this.drawableBuffers = new DrawableBuffers(inWebGL, inModelData);

		this.highlighted = false;
	} // ctor

	setHightlight(inHighlight = true) {
		this.highlighted = inHighlight;

		if (this.highlighted)
			this.transform.scaleVec3 = vec3.fromValues(OBJ_SELECTION_SCALE, OBJ_SELECTION_SCALE, OBJ_SELECTION_SCALE);
		else
			this.transform.scaleVec3 = vec3.fromValues(1, 1, 1);

			// console.debug(`Drawable.setHighlight(${inHighlight}): this.transform.scaleVec3=${this.transform.scaleVec3}`);
			// console.debug(`Resulting matrix = ${prettyPrintMat(this.transform.computeMatrix())}`);
		}
} // class Drawable
