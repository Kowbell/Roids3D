import { EObjectTypes, gameObjectsPendingDelete, resetPendingDelete, deleteObject } from "./modules/game-object.mjs";
import { OctreeNode, OCTREE_ROOT_NODE } from './octree.js';

// TODO gotta be a better way for the aliases... couldn't do `import { glMatrix.vec3 as vec3 }` or anything like that...
import './gl-matrix.js';

// #region Typedef's & Tiny Helpers :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

/** @typedef {number[]} vec3 [x, y, z] */
var vec3 = glMatrix.vec3;
/** @typedef {number[]} vec4 [x, y, z, w] */
var vec4 = glMatrix.vec4;
/** @typedef {number[]} quat [x, y, z, w] */
var quat = glMatrix.quat;
/** @typedef {number[]} mat4 16-component 1D matrix, column-major */
var mat4 = glMatrix.mat4;

function degToRad(d) { return d * Math.PI / 180; }
function printFlt(inObj, inPrecision = 3) { return JSON.stringify(inObj, function(key, val) { return val.toFixed ? Number(val.toFixed(inPrecision)) : val } ); }
function prettyPrint(inObj) { return JSON.stringify(inObj, null, 2); }
function prettyPrintMat(inMat) { return `\n[${inMat[0]}, ${inMat[1]}, ${inMat[2]}, ${inMat[3]},\n ${inMat[4]}, ${inMat[5]}, ${inMat[6]}, ${inMat[7]},\n ${inMat[8]}, ${inMat[9]}, ${inMat[10]}, ${inMat[11]},\n ${inMat[12]}, ${inMat[13]}, ${inMat[14]}, ${inMat[15]}]` };


/**
 * 
 * @param {WebGLRenderingContext} inGL 
 * @param {number} inErrorCode 
 */
function glErrorToString(inGL, inErrorCode) {
	switch (inErrorCode) {
		case inGL.INVALID_ENUM: return "INVALID_ENUM";
		case inGL.INVALID_VALUE: return "INVALID_VALUE (i.e. OUT-OF-RANGE)";
		case inGL.INVALID_OPERATION: return "INVALID_OPERATION";
		case inGL.INVALID_FRAMEBUFFER_OPERATION: return "INVALID_FRAMEBUFFER_OPERATION";
		case inGL.OUT_OF_MEMORY: return "OUT_OF_MEMORY";
		case inGL.CONTEXT_LOST_WEBGL: return "CONTEXT_LOST_WEBGL";
		default: throw `INVALID ERROR CODE=${inErrorCode}`
	}
}

function randRange(inMin, inMax) { return Math.random() * (inMax - inMin) + inMin; }
function randPosNeg() { return Math.random() > 0.5 ? 1 : -1; }

function lerp(inFrom, inTo, inTime) { return inFrom * (1-inTime) + inTo * inTime; }
function clamp(inVal, inMin, inMax) { return (inVal > inMax ? inMax : (inVal < inMin ? inMin : inVal)); }
// #endregion Typedef's & Tiny Helpers :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

class RollingAverage {
	/** @param {number} inLength */
	constructor(inLength) {
		this.length = inLength;

		/** @type {number[]} */
		this.values = new Array(5);
		this.values.fill(0);

		/** @type {number} */
		this.nextIdx = 0;
	}

	push(inValue) {
		this.values[this.nextIdx] = inValue;
		this.nextIdx = (this.nextIdx + 1) % this.length;
	}

	getAverage() {
		let sum = 0;
		for (let valueIdx = 0; valueIdx < this.length; valueIdx++)
			sum += this.values[valueIdx];
		return sum / this.length;
	}
} // RollingAverage

// #region Global Variables :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

/** Only update the octree this often */
const OCTREE_UPDATE_TIME_MS = 250;
/** Next time to update the tree (ms) */
let OCTREE_UPDATE_NEXT = 0;

var IS_PAUSED = false;
const DEG2RAD = Math.PI / 180;
const PI2 = Math.PI * 2;

const DEBUG_DRAW_COLLISION = true;
let DEBUG_DRAW_OCTREE = false;
/** @type {Drawable[]} Special drawables to render for only one frame & as gl.LINES */
var dbgDrawables = [];
/** @type {Object.<string, Drawable[]} Categorized drawables that do not need to be updated for several frames */
var dbgDrawablesPersist = {};

var canvas = null;
/** @type {WebGLRenderingContext} */
var gl = null;

/** @type {CanvasRenderingContext2D} */
var uiCanvas = null;

/** @type {Drawable[]} */
var drawables = [];

/** @type {GameObject[]} */
var gameObjects = [];

/** @type {GameObject[]} New objects should be added to this list. Next frame we'll enable them */
var gameObjectsPendingSpawn = [];

/** An "orbit"/"third-person" camera */
var CAMERA = {
	/** Easy to configure properties about the camera */
	xformConfig: {
		/** @type {vec3} World position the camera is focused on */
		lookAtPoint: vec3.fromValues(0, 0, 0.1),
		/** @type {vec3} Additional offset from the target point we want to look at. This will generally remain constant, while the lookAtPoint may change often */
		offset: vec3.fromValues(0, 0.1, 0),
		/** @type {number} Distance from the look at point the camera should be */
		distance: 0.5,
		/** @type {vec3} degrees [pitch, yaw, roll] about the lookAtPoint in degrees */
		rotation: vec3.fromValues(10, 0, 0),

		/** @type {number} units to move per second when input is given */
		transSpeed: 0.3,
		/** @type {number} degrees to rotate per second when input is given */
		rotSpeed: 5.0,

		zoomSpeed: 0.1,

		/** @type {Transform} optional transform to snap to; we will inherit their loc/rot/scale */
		parentTransform: undefined
	},

	perspConfig: {
		/** @type {number} in degrees */
		fieldOfView: 60,

		/** @type {number} gl.canvas aspect ratio (w / h) */
		canvasAspect: undefined,

		clipNear: 0.01,
		clipFar: 500,
	},

	input: {
		translation: vec3.create(),
		/** [pitchDegInput, rotDegInput, 0] */
		rotationDeg: vec3.create(),
		zoom: 0,
	},

	computed: {
		/** @type {mat4} The computed matrix representing the camera's world location/rotation */
		viewMatrix: undefined,
		/** @type {mat4} The computer matrix representing perspective stuff I dunno */
		projMatrix: undefined
	},

	processInput(inDeltaTime) {
		var didUpdate = false;
		
		var trans = vec3.clone(this.input.translation);
		var translationTarget = this.xformConfig.lookAtPoint;
		if (vec3.length(trans) > 0) {
			didUpdate = true;

			var translationThisFrame = this.xformConfig.transSpeed * inDeltaTime;
			trans[0] *= translationThisFrame;
			trans[1] *= translationThisFrame;
			trans[2] *= translationThisFrame;

			// Forward/right should be relative to the look direction
			vec3.rotateY(trans, trans, vec3.fromValues(0, 0, 0), this.xformConfig.rotation[1] * DEG2RAD);

			vec3.add(translationTarget, translationTarget, trans);
			debugDrawText("processInputTrans", `Camera Trans: raw=${JSON.stringify(this.input.translation)}, speed=${printFlt(translationThisFrame)}, lookAtPoint=${printFlt(this.xformConfig.lookAtPoint)}`);
		}

		var rot = vec3.clone(this.input.rotationDeg);
		var rotTarget = this.xformConfig.rotation;
		if (vec3.length(rot) > 0) {
			didUpdate = true;

			var rotationThisFrame = this.xformConfig.rotSpeed * inDeltaTime;
			rot[0] *= rotationThisFrame;
			rot[1] *= -rotationThisFrame; 
			rot[2] = 0;

			vec3.add(rotTarget, rotTarget, rot);
			debugDrawText("processInputMouse", `Camera Rot: raw=${JSON.stringify(this.input.rotationDeg)}, speed=${printFlt(rotationThisFrame)}, rotation=${printFlt(this.xformConfig.rotation)}`);
			// this.input.rotationDeg = vec3.create();
		}

		if (this.input.zoom != 0) {
			didUpdate = true;
			this.xformConfig.distance += this.input.zoom * this.xformConfig.zoomSpeed * inDeltaTime;
			// Clamp zoom
			this.xformConfig.distance = Math.max(this.xformConfig.distance, this.perspConfig.clipNear);
			this.xformConfig.distance = Math.min(this.xformConfig.distance, 10);
			this.input.zoom = 0;
		}

		if (didUpdate)
			this.computeViewMatrix();
	}, // processInput

	/** Generates the viewMatrix from our xformConfig values */
	computeViewMatrix() {
		var offsetLookAt = vec3.create();
		vec3.add(offsetLookAt, this.xformConfig.lookAtPoint, this.xformConfig.offset);

		var cameraPosition = vec3.clone(offsetLookAt);
		// Camera position is (distance) units behind the look at point in the Z axis so it is looking at it
		vec3.sub(cameraPosition, offsetLookAt, vec3.fromValues(0, 0, this.xformConfig.distance));
		// Rotate the camera around the pitch axis
		vec3.rotateX(cameraPosition, cameraPosition, offsetLookAt, DEG2RAD * this.xformConfig.rotation[0]);
		// Now rotate around the vertical
		vec3.rotateY(cameraPosition, cameraPosition, offsetLookAt, DEG2RAD * this.xformConfig.rotation[1]);

		debugDrawText("computeViewMatrix", `cameraPosition=${printFlt(cameraPosition)} offsetLookAt=${printFlt(offsetLookAt)}`);

		// Now generate a matrix at that position, using a rotation such that the camera is looking at the point
		let viewMat = mat4.create();
		mat4.lookAt(viewMat, cameraPosition, offsetLookAt, vec3.fromValues(0, 1, 0));

		if (this.xformConfig.parentTransform != undefined) {
			var parentMat = this.xformConfig.parentTransform.computeMatrix();
			var parentMatInv = mat4.create();
			mat4.invert(parentMatInv, parentMat);

			mat4.multiply(viewMat, viewMat, parentMatInv);
		}
		
		// Done!
		this.computed.viewMatrix = viewMat;
		// console.debug(`Computed view matrix=${prettyPrintMat(this.viewMatrix)}`);
	}, // computeViewMatrix

	computeProjMatrix() {
		this.computed.projMatrix = mat4.create();
		mat4.perspective(this.computed.projMatrix, this.perspConfig.fieldOfView * DEG2RAD, this.perspConfig.canvasAspect, this.perspConfig.clipNear, this.perspConfig.clipFar);
	}, // computeProjMatrix
};

/** Defined in loadShaders */
var ALL_SHADERS = {}

var SKYBOX = undefined;

const UI_TEXT_HEIGHT = 16;
const UI_LINE_HEIGHT = 1.15 * UI_TEXT_HEIGHT;
// #endregion Global Variables :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region Shaders Object Model :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

/**
 * All generic attribute data, particularly what's needed for gl.vertexAttribPointer at runtime
 * @property {string} name Name of the attribute as it appears in code
 * @property {number} size number of components per individual attribute. [1-4]
 * @property {GLenum} type "gl.BYTE|SHORT|UNSIGNED_BYTE|UNSIGNED_SHORT|FLOAT"; this is converted from a string in initialize()
 * @property {number} location pointer location
 */
class ShaderAttribute {
	/**
	 * @param {Shader} inShader 
	 * @param {string} inName 
	 * @param {number} inSize 
	 * @param {string} inTypeStr 
	 */
	constructor(inShader, inName, inSize, inTypeStr) {
		this.name = inName;
		this.size = inSize;
		this.type = ShaderAttribute.getGLType(inShader.glContext, inTypeStr);

		this.location = inShader.glContext.getAttribLocation(inShader.program, inName);
		inShader.glContext.enableVertexAttribArray(this.location);
	}; // ctor

	/** Called after a bindBuffer() call, this calls vertexAttribPointer with our config'd params */
	bindEnable(inShader) {
		inShader.glContext.vertexAttribPointer(this.location, this.size, this.type, false, 0, 0);
		inShader.glContext.enableVertexAttribArray(this.location); // TODO DO WE NEED TO DO THIS HERE TOO?
	} // bindEnable

	/**
	 * Gets the gl type enum needed for gl.vertexAttribPointer()
	 * https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/vertexAttribPointer
	 * @param {WebGLRenderingContext} inGL
	 * @param {string} inTypeString One of the following: "BYTE", "SHORT", "UNSIGNED_BYTE", "UNSIGNED_SHORT", "FLOAT"
	 * @returns {GLenum} GLenum type
	 */
	static getGLType(inGL, inTypeString) {
		var glType = undefined;
		switch (inTypeString) {
			case "BYTE":
				glType = inGL.BYTE;
				break;
			case "SHORT":
				glType = inGL.SHORT;
				break;
			case "UNSIGNED_BYTE":
				glType = inGL.UNSIGNED_BYTE;
				break;
			case "UNSIGNED_SHORT":
				glType = inGL.UNSIGNED_SHORT;
				break;
			case "FLOAT":
				glType = inGL.FLOAT;
				break;
			default:
				console.error(`Unrecognized gl type string "${inTypeString}"`);
				break;
		}
		return glType;
	}; // getGLType

	/**
	 * Generates a new GL array buffer from data, used for gl.bufferData()
	 * @param {WebGLRenderingContext} inGL 
	 * @param {GLenum} inGLType 
	 * @param {Iterable<number>} inRawData 
	 * @returns {ArrayBufferView} a new Float32Array, Int32Array, etc. (see https://developer.mozilla.org/en-US/docs/Web/API/ArrayBufferView)
	 */
	static generateArrayBufferType(inGL, inGLType, inRawData) {
		switch (inGLType) {
			case inGL.BYTE:           return new Int8Array(inRawData);
			case inGL.UNSIGNED_BYTE:  return new UInt8Array(inRawData);
			case inGL.SHORT:          return new Int16Array(inRawData);
			case inGL.UNSIGNED_SHORT: return new UInt16Array(inRawData);
			case inGL.FLOAT:          return new Float32Array(inRawData);
			default:
				console.error(`Unrecognized gl type "${inGLType}"`);
				return undefined;
		} // switch on inGLType
	}; // generateArrayBufferType
} // class ShaderAttribute

/**
 * All generic uniform data, particularly what's needed for gl.uniformFoo()
 * See also https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/uniform
 * See also https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/uniformMatrix
 * @property {WebGLUniformLocation} location pointer location
 * @property {function} glFunction The uniform callback; `gl.uniform[1234][fi][v]` or `gl.uniformMatrix[234]fv` 
 *     See https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/uniformMatrix
 *     See https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/uniform
 */
class ShaderUniform {
	/**
	 * @param {Shader} inShader 
	 * @param {string} inName 
	 * @param {function} inFunction The uniform callback; `gl.uniform[1234][fi][v]` or `gl.uniformMatrix[234]fv` 
	 *     See https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/uniformMatrix
	 *     See https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/uniform
	 */
	 constructor(inShader, inName, inFunction) {
		this.name = inName;

		this.location = inShader.glContext.getUniformLocation(inShader.program, inName);
		this.glFunction = inFunction;
	}; // ctor
} // class ShaderUniform

/**
 * All data needed for a shader: it's type, variables, compiled object, etc.
 * @typedef {Object} Shader
 * @property {WebGLRenderingContext} glContext
 * @property {WebGLProgram} program
 * @property {Object.<string, ShaderAttribute>} attributes Using their names as keys
 * @property {Object.<string, ShaderUniform>} uniforms Using their names as keys
 */
class Shader {
	constructor(inGL, inName) {
		this.name = inName;
		/** @type {WebGLRenderingContext} */
		this.glContext = inGL;
		/** @type {Object.<string, ShaderAttribute>} */
		this.attributes = {};
		/** @type {Object.<string, ShaderUniform>} */
		this.uniforms = {};
	}

	/** Adds a new ShaderAttribute to attributes & sets it up */
	defineAttribute(inName, inSize, inTypeStr) {
		this.attributes[inName] = new ShaderAttribute(this, inName, inSize, inTypeStr);
	}; // defineAttribute

	/** 
	 * Adds a new ShaderUniform to uniforms & sets it up 
	 * @param {function} inFunction The uniform callback; `gl.uniform[1234][fi][v]` or `gl.uniformMatrix[234]fv` 
	 */
	defineUniform(inName, inFunction) {
		this.uniforms[inName] = new ShaderUniform(this, inName, inFunction);
	}; // defineUniform

	compileProgram(inFragShaderSrc, inVertShaderSrc) {
		var fShader = this.glContext.createShader(this.glContext.FRAGMENT_SHADER);
		this.glContext.shaderSource(fShader, inFragShaderSrc);
		this.glContext.compileShader(fShader);
		if (!this.glContext.getShaderParameter(fShader, this.glContext.COMPILE_STATUS))
			throw `Error during fragment shader compile: "${this.glContext.getShaderInfoLog(fShader)}" (src="${inFragShaderSrc}")`

		var vShader = this.glContext.createShader(this.glContext.VERTEX_SHADER);
		this.glContext.shaderSource(vShader, inVertShaderSrc);
		this.glContext.compileShader(vShader);
		if (!this.glContext.getShaderParameter(vShader, this.glContext.COMPILE_STATUS))
			throw `error during vertex shader compile: "${this.glContext.getShaderInfoLog(vShader)}" (src="${inVertShaderSrc}")`
	
		this.program = this.glContext.createProgram();
		this.glContext.attachShader(this.program, fShader);
		this.glContext.attachShader(this.program, vShader);
		this.glContext.linkProgram(this.program);
		if (!this.glContext.getProgramParameter(this.program, this.glContext.LINK_STATUS))
			throw `error during shader program linking: ${this.glContext.getProgramInfoLog(this.program)}`	
	}; // compileProgram
};

// #endregion Shaders Object Model :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region Runtime Object Model :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

/**
 * Information loaded from triangle files at init time
 * This never changes
 */
class ModelData {
	constructor (inVertArray, inColorArray, inIndexArray, inUVsArray) {
		// Handle undefined arrays
		if (inVertArray  == undefined) inVertArray = [];
		if (inColorArray == undefined) inColorArray = [];
		if (inIndexArray == undefined) inIndexArray = [];
		if (inUVsArray == undefined) inUVsArray = [];

		/** @type {number[]} XYZ triplets for each vert */
		this.vertArray  = inVertArray;
		/** @type {number[]} RGB triplets for each vert */
		this.colorArray = inColorArray;
		this.indexArray = inIndexArray;
		this.uvsArray   = inUVsArray;
		// this.generateBarycentricCoordinates();
	} // ctor

	/** @returns {ModelData} */
	clone() {
		return new ModelData(this.vertArray.slice(), this.colorArray.slice(), this.indexArray.slice(), this.uvsArray.slice());
	}
} // class ModelData

/**
 * Translation/Scale vec3's and rotation quaternion
 * Matrix is computed from these + the camera view matrix
 * Rotation is in degrees!
 */
class Transform {
	constructor () {
		this.transVec3 = vec3.fromValues(0, 0, 0);
		this.rotQuat   = quat.create();
		this.scaleVec3 = vec3.fromValues(1, 1, 1);

		this.parentTransform = undefined;
	} // ctor()

	/**
	 * Scale --> rotate --> translate
	 * https://gamedev.stackexchange.com/a/16721
	 * But for math reasons... it's really translate -> rotate -> scale...?
	 * ¯\_(ツ)_/¯
	 * @return mat4
	 */
	computeMatrix() {
		var out = mat4.create();

		mat4.fromRotationTranslationScale(out, this.rotQuat, this.transVec3, this.scaleVec3);

		if (this.parentTransform != undefined) {
			var parentMat = this.parentTransform.computeMatrix();
			mat4.multiply(out, parentMat, out);
		}
		return out;
	} // computeMatrix()
} // class Transform

/**
 * Vertex, Color, and Triangle buffers for a drawable
 * Based on ModelData, so this is loaded at init and likely never changes
 * 
 * @typedef {Object} AttribData
 * @property {WebGLBuffer} buffer The actual buffer from gl.createBuffer
 * @property {GLenum} bufferType one of the gl.FLOAT, gl.BYTE, etc. types
 * @property {Iterable<number>} rawData Raw buffer data array
 *
 * @typedef {Object} UniformData
 * @property {any[]} args Argument list to pass to the method. Depends on the callback
 */
class ShaderConfig {

	/** @param {ModelData} inModelData 
	 * @param {Shader} inShader
	 * @param {TextureData} inTexture Optional texture data if this is a textured shader */
	constructor (inModelData, inShader, inTexture = undefined) {
		/** @type {Shader} shader data */
		this.shader = inShader;
		this.renderMode = inShader.glContext.TRIANGLES;

		// #region Set up attributes
		/** @type {Object.<string, AttribData>} All attributes by their name in the shader */
		this.attributes = {};
		for (const attribName in inShader.attributes) {
			const attrib = inShader.attributes[attribName];
			
			this.attributes[attribName] = {};
			this.attributes[attribName].buffer = gl.createBuffer();
			this.attributes[attribName].bufferType = attrib.type;
			this.attributes[attribName].rawData = undefined;
		} 

		// TODO 🤔 we have to manually specify the data based on the attribute names
		if (inShader.name == "generic") {
			this.attributes["a_vertexPos"].rawData = inModelData.vertArray;
			this.attributes["a_vertexCol"].rawData = inModelData.colorArray;
		} else if (inShader.name == "color_wireframe") {
			this.attributes["a_vertexPos"].rawData = inModelData.vertArray;
			this.attributes["a_vertexCol"].rawData = inModelData.colorArray;

			var baryArray = [];
			var wireColorsArray = [];
			for (var vertIdx = 0; vertIdx < inModelData.indexArray.length; vertIdx++) {
				var thisVertBary = [0, 0, 0]; thisVertBary[vertIdx % 3] = 1;
				baryArray = baryArray.concat(thisVertBary);
				wireColorsArray = wireColorsArray.concat([1, 0, 1]);
			}
			inModelData.baryArray = baryArray;
			this.attributes["a_baryCoords"].rawData = inModelData.baryArray;
			this.attributes["a_wireframeColor"].rawData = wireColorsArray;

		} else if (inShader.name == "textured") {
			this.attributes["a_vertexPos"].rawData = inModelData.vertArray;
			this.attributes["a_uvCoords"].rawData = inModelData.uvsArray;

			// Assign each triangle vertex a barycentric coordinate, with the 
			// first vert being [1,0,0], the second being [0,1,0], the third being [0,0,1]
			var baryArray = [];
			var wireColorsArray = [];
			for (var vertIdx = 0; vertIdx < inModelData.indexArray.length; vertIdx++) {
				var thisVertBary = [0, 0, 0]; thisVertBary[vertIdx % 3] = 1;
				baryArray = baryArray.concat(thisVertBary);
				wireColorsArray = wireColorsArray.concat([1, 0, 1]);
			}
			inModelData.baryArray = baryArray;
			this.attributes["a_baryCoords"].rawData = inModelData.baryArray;
			this.attributes["a_wireframeColor"].rawData = wireColorsArray;
		} else {
			throw `HECK! DANG! WE DON'T KNOW WHAT TO DO WITH THIS SHADER! ${inShader.name}`;
		}
		// #endregion Set up attributes

		// #region Set up uniforms
		/** @type {Object.<string, UniformData>} All uniforms by their name in the shader */
		this.uniforms = {};
		for (const uniformName in inShader.uniforms) {
			const uniform = inShader.uniforms[uniformName];
			this.uniforms[uniformName] = {"args":[uniform.location]};

			// For matrix uniforms (typically model view & projection matrices), prealloc their float arrays
			if (uniform.glFunction == gl.uniformMatrix4fv) {
				var matrix = undefined;

				// Extra special case: projection matrix never changes
				if (uniformName == "u_projectionMatrix")
					matrix = CAMERA.computed.projMatrix;
				else
					matrix = mat4.create();

				// Two args: transpose=false, prealloc mat array
				this.uniforms[uniformName].args.push(false, new Float32Array(matrix) );
			}
		}

		// TODO 🤔 we have to manually specify the data based on the attribute names
		if (inShader.name == "generic") {
			// Nothing...
		} else if (inShader.name == "color_wireframe") {
			// NOTHING...
		} else if (inShader.name == "textured") {
			// this.uniforms["u_textureSampler"].args.push(inTexture);
		} else {
			throw `HECK! DANG! WE DON'T KNOW WHAT TO DO WITH THIS SHADER! ${inShader.name}`;
		}
		// #endregion Set up uniforms

		this.refreshAllBuffers();

		/** @type {WebGLBuffer} */
		this.triIndexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIndexBuffer); 
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(inModelData.indexArray), gl.STATIC_DRAW);
		this.triIndexBufferLength = inModelData.indexArray.length;
	} // ctor

	/**
	 * Binds the attribute buffer and re-feeds the buffer data
	 * @param {AttribData} inAttribData 
	 * @param {Iterable<number>|undefined} inData optional new data to use & overwrite inAttribData.rawData with
	 */
	refreshAttribData(inAttribName, inData = undefined) {
		var attribData = this.attributes[inAttribName];
		if (inData != undefined)
			attribData.rawData = inData;

		if (attribData.rawData == undefined || attribData.rawData.length == 0) console.warn(`ZERO-LENGTH RAW BUFFER DATA FOR ${inAttribName}`);

		gl.bindBuffer(gl.ARRAY_BUFFER, attribData.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, ShaderAttribute.generateArrayBufferType(gl, attribData.bufferType, attribData.rawData), gl.STATIC_DRAW);
	} // refreshAttribData

	/**
	 * Calls refreshAttribData() on all defined local attributes
	 */
	refreshAllBuffers() {
		for (const attributeName in this.attributes)
			this.refreshAttribData(attributeName);
	} // refreshAllBuffers
} // class ShaderConfig

class Drawable {
	constructor (inName, inModelData, inShader) {
		this.name = inName;
		/** @type {ModelData} */
		this.modelData = inModelData;
		this.transform = new Transform();
		this.shaderConfig = new ShaderConfig(inModelData, inShader);

		this.isDebug = false;
	} // ctor
	/** @param {WebGLRenderingContext} inGL */
	draw(inGL) {
		var shader = this.shaderConfig.shader;
		gl.useProgram(shader.program);

		// Bind & push attribute buffers...
		for (const attribName in this.shaderConfig.attributes) {
			const attribShaderData = shader.attributes[attribName];
			const bufferData = this.shaderConfig.attributes[attribName];

			inGL.bindBuffer(inGL.ARRAY_BUFFER, bufferData.buffer);
			inGL.vertexAttribPointer(attribShaderData.location, attribShaderData.size, attribShaderData.type, false, 0, 0);
			inGL.enableVertexAttribArray(attribShaderData.location);
		}
		// ...done drawing & pushing attribute buffers!

		// Bind & push uniform buffers...
		var DBG_HAD_MVM = false;
		for (const uniformName in this.shaderConfig.uniforms) {
			const shaderUniform = shader.uniforms[uniformName];
			const uniformData = this.shaderConfig.uniforms[uniformName];

			if (shaderUniform.glFunction == undefined || uniformData.args == undefined) continue;

			if (shaderUniform.glFunction == inGL.uniformMatrix4fv) {
				if (uniformName == "u_modelViewMatrix") { DBG_HAD_MVM = true;
					let modelViewMat = mat4.create();
					mat4.multiply(modelViewMat, CAMERA.computed.viewMatrix, this.transform.computeMatrix());
					// args[2] will be the already-allocated array, so we can copy right over
					mat4.copy(uniformData.args[2], modelViewMat);
				} else if (uniformName == "u_projectionMatrix") {
					// HECKIN TODO
					gl.uniformMatrix4fv(shaderUniform.location, false, new Float32Array(CAMERA.computed.projMatrix));
					continue;
				}
			}

			shaderUniform.glFunction.apply(inGL, uniformData.args);
		}
		// ...done drawing & pushing attribute buffers!

		inGL.bindBuffer(inGL.ELEMENT_ARRAY_BUFFER, this.shaderConfig.triIndexBuffer);
		inGL.drawElements(this.shaderConfig.renderMode, this.shaderConfig.triIndexBufferLength, inGL.UNSIGNED_SHORT, 0);
		
		// var err = inGL.getError();
		// if (err != inGL.NO_ERROR) {
		// 	console.warn(`CAUGHT ERROR DRAWING ${this.name}: ERRCODE==${err} (${glErrorToString(inGL, err)})\nSHADERCONFIG=${JSON.stringify(this.shaderConfig)}`);
		// }
	} // draw()
} // class Drawable

class GameObject {
	/**
	 * @param {string} inType within EObjectTypes
	 * @param {Drawable} inDrawable 
	 * @param {number} inCollisionRadius 
	 * @param {string} [inName] if not provided, the type is used
	 * @param {vec3} [inVelocityVec3]
	 */
	constructor(inType, inDrawable, inCollisionRadius, inName = undefined, inVelocityVec3 = undefined) {
		this.type = inType,
		this.name = inName != undefined ? inName : inType;
		this.drawable = inDrawable;
		this.collisionRadius = inCollisionRadius;
		this._collisionRadiusSquared = this.collisionRadius * this.collisionRadius;
		this.velocityVec3 = inVelocityVec3 != undefined ? inVelocityVec3 : vec3.create();
		this.enabled = false;
	} // ctor

	checkCollision(inOtherObject) {
		if (inOtherObject == undefined || inOtherObject.drawable == undefined)
			throw `CHECKCOLLISION: UNDEFINED OBJ/DRAWABLE: OBJ NAME=${inOtherObject != undefined ? inOtherObject.name : 'undefined'}, enabled = ${inOtherObject != undefined ? inOtherObject.enabled : false} ; pendingDeletes=${gameObjectsPendingDelete.indexOf(inOtherObject)}, pendingSpawns=${gameObjectsPendingSpawn.indexOf(inOtherObject)}`;

		let distSq = vec3.squaredDistance(this.drawable.transform.transVec3, inOtherObject.drawable.transform.transVec3);
		return distSq < (this._collisionRadiusSquared + inOtherObject._collisionRadiusSquared);
	}
} // class GameObject
// #endregion Runtime Object Model :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region Loading Helpers :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

/**
 * @type {Object.<string, LoadedData>}
 *
 * @typedef {Object} LoadedData
 * @property {string} path
 * @property {string} loadedSrc
 * @property {ModelData|Object} parsed
 */
var ALL_LOADED_TEXT = {
	/** @type {LoadedData} */
	PLAYER_SHIP: {
		path: "models/playerShip.obj",
		loadedSrc: undefined,
		/** @type {ModelData} Parsed from the .obj file source */
		parsed: undefined
	},

	/** @type {LoadedData} */
	UV_SPHERE: {
		path: "models/sphere.obj",
		loadedSrc: undefined,
		/** @type {ModelData} Parsed from the .obj file source */
		parsed: undefined
	},

	/** @type {LoadedData} */
	ICO_SPHERE: {
		path: "models/icoSphere.obj",
		loadedSrc: undefined,
		/** @type {ModelData} Parsed from the .obj file source */
		parsed: undefined
	},

	DBG_OCTREE_NODE: {
		path: "models/octreeNode.obj",
		loadedSrc: undefined,
		parsed: undefined,
	},

	/** @type {LoadedData} */
	SHOT: {
		path: "models/playerShot.obj",
		loadedSrc: undefined,
		/** @type {ModelData} Parsed from the .obj file source */
		parsed: undefined
	},

	/** @type {LoadedData} */
	SKYBOX: {
		path: "models/skysphere.obj",
		loadedSrc: undefined,
		/** @type {ModelData} Parsed from the .obj file source */
		parsed: undefined
	},

	/** @type {LoadedData} */
	SHADER_GENERIC_VERT: {
		path: "shaders/shaderGeneric.vert",
		loadedSrc: undefined,
		/** @type {WebGLShader} via gl.createShader, only if compilation successful */
		parsed: undefined
	},
	/** @type {LoadedData} */
	SHADER_GENERIC_FRAG: {
		path: "shaders/shaderGeneric.frag",
		loadedSrc: undefined,
		/** @type {WebGLShader} via gl.createShader, only if compilation successful */
		parsed: undefined
	},

	/** @type {LoadedData} */
	SHADER_COLOR_WIREFRAME_VERT: {
		path: "shaders/shaderVertColorWireframe.vert",
		loadedSrc: undefined,
		/** @type {WebGLShader} via gl.createShader, only if compilation successful */
		parsed: undefined
	},
	/** @type {LoadedData} */
	SHADER_COLOR_WIREFRAME_FRAG: {
		path: "shaders/shaderVertColorWireframe.frag",
		loadedSrc: undefined,
		/** @type {WebGLShader} via gl.createShader, only if compilation successful */
		parsed: undefined
	},

	/** @type {LoadedData} */
	SHADER_TEXTURED_VERT: {
		path: "shaders/shaderTextured.vert",
		loadedSrc: undefined,
		/** @type {WebGLShader} via gl.createShader, only if compilation successful */
		parsed: undefined
	},
	/** @type {LoadedData} */
	SHADER_TEXTURED_FRAG: {
		path: "shaders/shaderTextured.frag",
		loadedSrc: undefined,
		/** @type {WebGLShader} via gl.createShader, only if compilation successful */
		parsed: undefined
	},

	/** @type {string[]} */
	_pendingLoads: [],
	_pendingLoadsCallback: undefined,
	_pendingLoadsStart: undefined,
	onPendingComplete(inName, inText) {
		this[inName].loadedSrc = inText;
		this._pendingLoads.splice(this._pendingLoads.indexOf(inName), 1);
		// console.log(`Load completed for "${inName}" [${inText.length} long]. ${this._pendingLoads.length} left!`);

		if (this._pendingLoads.length == 0) {
			console.log(`All loads complete [${Date.now() - this._pendingLoadsStart}ms]!`);
			this._pendingLoadsCallback.apply();
		}
	}, // onPendingComplete

	doLoad(inOnCompleteCallback) {
		if (this._pendingLoads != undefined && this._pendingLoads.length > 0)
			throw `doLoad call with pending loads left: ${JSON.stringify(this._pendingLoads)}`;

		this._pendingLoads = [];
		this._pendingLoadsCallback = inOnCompleteCallback;
		this._pendingLoadsStart = Date.now();

		for (const dataName in this) {
			var loadedData = this[dataName];
			// Skip invalid & already loaded
			if (loadedData == undefined || loadedData.path == undefined || loadedData.loadedSrc != undefined) continue;

			let xhr = new XMLHttpRequest();
			xhr.open("GET", loadedData.path, true);
			xhr.responseType = "text";

			xhr.onload = function (e) {
				if (xhr.readyState === 4) {
					if (xhr.status === 200)
						ALL_LOADED_TEXT.onPendingComplete(dataName, xhr.responseText);
					else
						console.error(`XMLHttpRequest for data "${dataName}" at path "${loadedData.path}"! Error: "${xhr.statusText}"`);
				} else // xhr.readyState is bad
					console.error(`XMLHttpRequest for data "${dataName}" at path "${loadedData.path}"! Error: "${xhr.statusText}"`);
			}; // onLoad
			xhr.onerror = function (e) {
				console.error(`XMLHttpRequest for data "${dataName}" at path "${loadedData.path}"! Error: "${xhr.statusText}"`);
			};

			xhr.send(null);
			// console.log(`PEND LOAD ${dataName}`);
			this._pendingLoads.push(dataName);
		} // foreach element, start async request
	}, // doLoad
}; // ALL_LOADED_TEXT

/**
 * @type {Object.<string, TextureData>}
 *
 * @typedef {Object} TextureData
 * @property {string} path
 * @property {HTMLImageElement} image
 * @property {WebGLTexture} texture
 * @property {number} boundTextureIdx Index as used for activeTexture(); this will be an offset from gl.TEXTURE0
 */
var ALL_LOADED_IMG = {
	/** Index to used for the next loaded textures `boundTextureIdx`; incremented once used */
	_nextTextureIdx: 0,

	/** @type {TextureData} */
	ASTEROID: {
		path: "textures/asteroid.png",
		image: undefined,
		texture: undefined,
		boundTextureIdx: undefined
	},

	/** @type {TextureData} */
	SKYBOX: {
		path: "textures/skybox.png",
		image: undefined,
		texture: undefined,
		boundTextureIdx: undefined
	},

	/** @param {WebGLRenderingContext} inGL */
	doLoad(inGL) {
		function isPowerOf2(value) { return (value & (value - 1)) == 0; }

		for (const dataName in this) {
			let dataObj = this[dataName];
			// Skip invalid & already loaded
			if (dataObj == undefined || dataObj.path == undefined) continue;
			
			dataObj.texture = inGL.createTexture();
			dataObj.boundTextureIdx = ALL_LOADED_IMG._nextTextureIdx++;

			inGL.activeTexture(inGL.TEXTURE0 + dataObj.boundTextureIdx);
			
			// Set up placeholder texture until load is complete...
			inGL.bindTexture(inGL.TEXTURE_2D, dataObj.texture);
			inGL.texImage2D(inGL.TEXTURE_2D, 0, inGL.RGBA, 1, 1, 0, inGL.RGBA, inGL.UNSIGNED_BYTE, new Uint8Array([255, 0, 255, 255])); // magenta is the best debug color, don't @ me

			dataObj.image = new Image();
			dataObj.image.crossOrigin = "Anonymous";
			dataObj.image.src = dataObj.path;
			dataObj.image.onerror = function() { console.error(`Failed to load image from url="${dataObj.path}"`); }
			dataObj.image.onload = function () {
				inGL.activeTexture(inGL.TEXTURE0 + dataObj.boundTextureIdx);
				inGL.bindTexture(inGL.TEXTURE_2D, dataObj.texture);
				inGL.texImage2D(inGL.TEXTURE_2D, 0, inGL.RGBA, inGL.RGBA, inGL.UNSIGNED_BYTE, dataObj.image);
	
				// Mipmaps and clamping are handled different for power-of-2 and non-po2 images
				var powerOf2 = isPowerOf2(dataObj.image.width) && isPowerOf2(dataObj.image.height);
				if (powerOf2) {
					inGL.generateMipmap(inGL.TEXTURE_2D);
				} else {
					inGL.texParameteri(inGL.TEXTURE_2D, inGL.TEXTURE_WRAP_S, inGL.CLAMP_TO_EDGE);
					inGL.texParameteri(inGL.TEXTURE_2D, inGL.TEXTURE_WRAP_T, inGL.CLAMP_TO_EDGE);
					inGL.texParameteri(inGL.TEXTURE_2D, inGL.TEXTURE_MIN_FILTER, inGL.LINEAR);
				}

				inGL.texParameteri(inGL.TEXTURE_2D, inGL.TEXTURE_MAG_FILTER, inGL.NEAREST);
			} // image onload
		} // foreach element
	}, // doLoad
}; // ALL_LOADED_IMG

/**
 * @type {Object.<string, AudioData>}
 *
 * @typedef {Object} AudioData
 * @property {string} path
 * @property {AudioContext} context
 * @property {AudioBuffer} buffer
 * @property {AudioBufferSourceNode} [playbackNode] Current playback instance, mainly for audio
 * @property {boolean} [introStub] Whether this is an "intro stub" audio file, which uses an additional callback
 */
var ALL_LOADED_AUDIO = {
	"MUSIC_INTRO_STUB": {
		"path": "audio/people_vultures_stub.ogg",
		"introStub": true
	},

	"MUSIC": {
		"path": "audio/people_vultures_altstart.ogg"
	},

	"PLAYER_SHOT": {
		"path": "audio/classic_fire.wav"
	},

	"ASTEROID_EXPLOSION_SMALL": {
		"path": "audio/classic_bangSmall.wav"
	},

	"ASTEROID_EXPLOSION_MEDIUM": {
		"path": "audio/classic_bangMedium.wav"
	},

	"ASTEROID_EXPLOSION_LARGE": {
		"path": "audio/classic_bangLarge.wav"
	},

	/** @type {string[]} */
	_pendingLoads: [],
	_pendingLoadsStubCallback: undefined,
	_pendingLoadsCompleteCallback: undefined,
	_pendingLoadsStart: undefined,
	onPendingComplete(inName) {
		this._pendingLoads.splice(this._pendingLoads.indexOf(inName), 1);
		// console.log(`Load completed for audio "${inName}" [${inText.length} long]. ${this._pendingLoads.length} left!`);

		if (this[inName].introStub == true) {
			console.log(`Stub audio load complete [after ${Date.now() - this._pendingLoadsStart}ms]`);
			if (this._pendingLoadsStubCallback != undefined)
				this._pendingLoadsStubCallback.apply();
		}

		if (this._pendingLoads.length == 0) {
			console.log(`All audio loads complete [${Date.now() - this._pendingLoadsStart}ms]!`);
			if (this._pendingLoadsCompleteCallback != undefined)
				this._pendingLoadsCompleteCallback.apply();
		}
	}, // onPendingComplete

	/** Called when an XMLHttpRequest has loaded the raw audio data. */
	onXHRComplete(inName, inResponse) {
		console.debug(`Loaded raw audio data for '${inName}', doing decode...`);
		let ctx = new AudioContext();
		this[inName].context = ctx;
		ctx.decodeAudioData(inResponse, 
			function(inBuffer) { ALL_LOADED_AUDIO.onDecodeAudioSuccess(inName, inBuffer); },
			function() { throw `ERROR DECODING AUDIO FOR ${inName}`; }
		);
	},

	/** Called when audio data is successfully decoded and ready to play */
	onDecodeAudioSuccess(inName, inBuffer) {
		ALL_LOADED_AUDIO[inName].buffer = inBuffer;
		console.debug(`Decoded audio for '${inName}', it is ready to play!`);
		ALL_LOADED_AUDIO.onPendingComplete(inName);
	},

	doLoad(inOnCompleteCallback, inOnIntroStubCompleteCallback) {
		if (this._pendingLoads != undefined && this._pendingLoads.length > 0)
			throw `doLoad call with pending loads left: ${JSON.stringify(this._pendingLoads)}`;

		this._pendingLoads = [];
		this._pendingLoadsCompleteCallback = inOnCompleteCallback;
		this._pendingLoadsStubCallback = inOnIntroStubCompleteCallback;
		this._pendingLoadsStart = Date.now();

		for (const dataName in this) {
			var loadedData = this[dataName];
			// Skip invalid & already loaded
			if (loadedData == undefined || loadedData.path == undefined || loadedData.loadedSrc != undefined) continue;

			let xhr = new XMLHttpRequest();
			xhr.open("GET", loadedData.path, true);
			xhr.responseType = "arraybuffer";

			xhr.onload = function (e) {
				if (xhr.readyState === 4) {
					if (xhr.status === 200)
						ALL_LOADED_AUDIO.onXHRComplete(dataName, xhr.response);
					else
						console.error(`XMLHttpRequest for data "${dataName}" at path "${loadedData.path}"! Error: "${xhr.statusText}"`);
				} else // xhr.readyState is bad
					console.error(`XMLHttpRequest for data "${dataName}" at path "${loadedData.path}"! Error: "${xhr.statusText}"`);
			}; // onLoad
			xhr.onerror = function (e) {
				console.error(`XMLHttpRequest for data "${dataName}" at path "${loadedData.path}"! Error: "${xhr.statusText}"`);
			};

			xhr.send(null);
			// console.log(`PEND LOAD ${dataName}`);
			this._pendingLoads.push(dataName);
		} // foreach element, start async request
	}, // doLoad
}

/**
 * 
 * @param {string} source Source text
 * @returns {ModelData} Vertex, normal, and triangle index data
 */
function parseObj(source) {
	if (source.length == 0) {
		console.warn(`Empty source passed to parseOBj!`);
		return undefined;
	}

	/** Textures were loading upside-down; flip them at load time. */
	function flipUV(inUv) { return Math.abs(1 - inUv); }

	/**
	 * Parses every component in the source array from strings into numbers, throwing if NaN so we have
	 * an early warning & stack trace.
	 * @param {string[]} inSrcArray The full tokenized line: A string first value, followed by numbers
	 * @returns {number[]} Parsed values; length will be `inSrcArray.length - 1`
	 */
	function parseFloatArrayOrErr(inSrcArray) {
		var outArray = [];
		for (var inpIdx = 1; inpIdx < inSrcArray.length; inpIdx++) {
			var parsed = Number.parseFloat(inSrcArray[inpIdx]);
			if (Number.isNaN(parsed))
				throw `Invalid component at idx=${inpIdx} from OBJ line=${JSON.stringify(inSrcArray)}`;
			outArray.push(parsed);
		}
		return outArray;
	} // parseFloatArrayOrErr

	// #region Reading into Raw Data Arrays
	/** @type {number[][]} Array of 3-component vertex positions as given in obj */
	var rawPosArray = [];
	/** @type {number[][]} Array of 2-component uv coords as given in obj */
	var rawUVsArray = [];
	/** @type {number[][]} Array of 3-component vertex normals as given in obj */
	var rawNrmArray = [];

	/** 
	 * @typedef {Object} TriIndices Each triangle's position, uv, and normal indices
	 * @property {number[]} posIndices 3 Position indices in rawPosArray. This is 0-based (converted from .OBJ 1-based)
	 * @property {number[]|undefined} uvIndices 3 UV indices in rawUVsArray. This is 0-based (converted from .OBJ 1-based)
	 * @property {number[]|undefined} nrmIndices 3 Normals indices in rawNrmArray. This is 0-based (converted from .OBJ 1-based)
	 */ /**
	 * @type {TriIndices[]} Array of 3-component triangle indices as given in obj
	 */
	var trisArray = [];

	// Parse line by line
	var srcLines = source.split('\n');
	for (var lineIdx = 0; lineIdx < srcLines.length; lineIdx++) {
		var line = srcLines[lineIdx];

		// Skip comment lines:
		if (line[0] == "#") continue;
		// I reckon this means a different "sub-object" in the file, but I don't see it in any specs...
		if (line[0] == "o") continue;
		// "smooth shading on/off", we don't shade smoothly
		if (line[0] == "s") continue;

		// Split now that we know we need to parse it's values
		var lineTokens = line.split(" ");
		if (lineTokens[0] == "v") {
			// Three vertex points in space
			rawPosArray.push(parseFloatArrayOrErr(lineTokens));
		} else if (lineTokens[0] == "vn") {
			// Three vertex normals
			rawNrmArray.push(parseFloatArrayOrErr(lineTokens));
		} else if (lineTokens[0] == "vt") {
			// Two uv coordinates
			var rawUVs = parseFloatArrayOrErr(lineTokens);
			// Need to flip y:
			rawUVs[1] = flipUV(rawUVs[1]);
			rawUVsArray.push(rawUVs);
		} else if (lineTokens[0] == "f") {
			// Face indices
			var posIndices = [];
			var uvIndices = [];
			var nrmIndices = [];

			// No support for non-triangle faces
			if (lineTokens.length != 4) {
				console.warn(`FACE HAS MORE THAN 3 VERTICES! IGNORING: ${JSON.stringify(lineTokens)}`);
				continue;
			}

			// Parse this triangle's pos/uv/norm indices
			for (var pointIdx = 1; pointIdx < lineTokens.length; pointIdx++) {
				var pointToken = lineTokens[pointIdx];
				var splitToken = pointToken.split('/');

				// First value will be vertex position index
				var posIdx = Number.parseFloat(splitToken[0]);
				posIndices.push(posIdx - 1); // -1 sinc obj uses 1 for first idx

				// This may have neither normals nor uvs specified
				if (splitToken.length == 1) continue;

				// If we do have uvs and/or normals specified,
				// Second token will be UV coord index.
				// This is optional so if we only have normals it will parse NaN!
				var uvIdx = Number.parseFloat(splitToken[1]);
				if (Number.isNaN(uvIdx) == false) uvIndices.push(uvIdx - 1); // -1 sinc obj uses 1 for first idx

				if (splitToken.length == 2) continue;

				var normIdx = Number.parseFloat(splitToken[2]);
				nrmIndices.push(normIdx - 1); // -1 sinc obj uses 1 for first idx
			}
			// Done parsing this triangle's pos/uv/norm indices

			/** @type {TriIndices} */
			var tri = {};
			tri.posIndices = posIndices;
			tri.uvIndices = uvIndices.length > 0 ? uvIndices : undefined;
			tri.nrmIndices = nrmIndices.length > 0 ? nrmIndices : undefined;
			trisArray.push(tri);
			
		} else if (line.length > 0) {
			console.warn(`Unrecognized first token of parsable line "${lineTokens}"`);
		}
	} // foreach line
	// #endregion Reading into Raw Data Arrays

	// #region Converting so Each Tri Idx has Unique Data
	var adjustedPosArray = [];
	var adjustedUVsArray = [];
	var adjustedNrmArray = [];
	var adjustedIdxArray = [];
	var adjustedColArray = [];

	for (var objIdx = 0; objIdx < trisArray.length; objIdx++) {
		var tri = trisArray[objIdx]; // This naming is starting to get really confusing...

		tri.posIndices.forEach(idx => adjustedPosArray = adjustedPosArray.concat(rawPosArray[idx]));
		if (tri.uvIndices != undefined)
			tri.uvIndices.forEach(idx => adjustedUVsArray = adjustedUVsArray.concat(rawUVsArray[idx]));
		if (tri.nrmIndices != undefined)
			tri.nrmIndices.forEach(idx => adjustedNrmArray = adjustedNrmArray.concat(rawNrmArray[idx]));

		for (var i=0; i<3; i++) adjustedColArray.push(1, 0, 1);
		
		var triFirstIdx = objIdx * 3;
		adjustedIdxArray = adjustedIdxArray.concat( [triFirstIdx, triFirstIdx + 1, triFirstIdx + 2] );
	} // foreach rawIdxArray obj
	// #endregion Converting so Each Tri Idx has Unique Data
	
	var modelData = new ModelData(adjustedPosArray, adjustedColArray, adjustedIdxArray, adjustedUVsArray);
	
	// console.log(`Parsed ModelData="${JSON.stringify(modelData)}" from OBJ file="${"source"}"`)
	return modelData;
} // parseObj

// #endregion Loading Helpers :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region Init Methods :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

function setupWebGL() {
	// Get the canvas and context
	canvas = document.getElementById("mainWebGLCanvas");
	
	gl = canvas.getContext("webgl");
	if (gl == null)
		throw "unable to create gl context -- is your browser gl ready?";
	
	CAMERA.perspConfig.canvasAspect = gl.canvas.clientWidth / gl.canvas.clientHeight;

	gl.clearColor(0.2, 0.0, 0.2, 1.0);
	gl.clearDepth(1.0);
	gl.enable(gl.DEPTH_TEST);
} // setupWebGl()

function setupUI() {
	var canvas = document.getElementById("uiCanvas");
	uiCanvas = canvas.getContext('2d');
} // setupUI

function setupSkybox() {
	ALL_LOADED_TEXT.SKYBOX.parsed = parseObj(ALL_LOADED_TEXT.SKYBOX.loadedSrc);
	let SKYBOXDRAW = ALL_LOADED_TEXT.SKYBOX.parsed;

	SKYBOX = new Drawable("Skybox", SKYBOXDRAW, ALL_SHADERS["textured"]);
	SKYBOX.shaderConfig.uniforms["u_textureSampler"].args.push(ALL_LOADED_IMG["SKYBOX"]);

	SKYBOX.shaderConfig.uniforms["u_wireframeThickness"].args.push(0);
	var rawColors = [];
	for (var vertIdx = 0; vertIdx < SKYBOX.modelData.indexArray.length; vertIdx++) {
		rawColors = rawColors.concat([1, 1, 1]);
	}
	SKYBOX.shaderConfig.attributes["a_wireframeColor"].rawData = rawColors;
	SKYBOX.shaderConfig.refreshAllBuffers();

	SKYBOX.transform.transVec3 = CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3;
	SKYBOX.transform.scaleVec3 = vec3.fromValues(1000, 1000, 1000);

	// drawables.push(SKYBOX);
} // setupSkybox

/**
 * Loads & compiles the known shaders and defines their attributes
 * @param {WebGLRenderingContext} inGL
 */
function initializeShaders(inGL) {
	// Generic Shader
	{
		var fShaderCode = ALL_LOADED_TEXT.SHADER_GENERIC_FRAG.loadedSrc;
		var vShaderCode = ALL_LOADED_TEXT.SHADER_GENERIC_VERT.loadedSrc;
		
		var theShader = new Shader(inGL, "generic");
		theShader.compileProgram(fShaderCode, vShaderCode);
		theShader.defineAttribute("a_vertexPos", 3, "FLOAT");
		theShader.defineAttribute("a_vertexCol", 3, "FLOAT");
		theShader.defineUniform("u_modelViewMatrix", inGL.uniformMatrix4fv);
		theShader.defineUniform("u_projectionMatrix", inGL.uniformMatrix4fv);

		ALL_SHADERS["generic"] = theShader;
	}
	// Generic Shader

	// Vertex Color w/ Wireframes Shader
	{
		var fShaderCode = ALL_LOADED_TEXT.SHADER_COLOR_WIREFRAME_FRAG.loadedSrc;
		var vShaderCode = ALL_LOADED_TEXT.SHADER_COLOR_WIREFRAME_VERT.loadedSrc;
		
		var theShader = new Shader(inGL, "color_wireframe");
		theShader.compileProgram(fShaderCode, vShaderCode);
		theShader.defineAttribute("a_vertexPos", 3, "FLOAT");
		theShader.defineAttribute("a_vertexCol", 3, "FLOAT");
		theShader.defineAttribute("a_baryCoords", 3, "FLOAT");
		theShader.defineAttribute("a_wireframeColor", 3, "FLOAT");

		theShader.defineUniform("u_modelViewMatrix", inGL.uniformMatrix4fv);
		theShader.defineUniform("u_projectionMatrix", inGL.uniformMatrix4fv);
		theShader.defineUniform("u_wireframeThickness", inGL.uniform1f);

		ALL_SHADERS["color_wireframe"] = theShader;
	}
	// Vertex Color w/ Wireframes Shader

	// Textured Shader
	{
		var fShaderCode = ALL_LOADED_TEXT.SHADER_TEXTURED_FRAG.loadedSrc;
		var vShaderCode = ALL_LOADED_TEXT.SHADER_TEXTURED_VERT.loadedSrc;
		
		var theShader = new Shader(inGL, "textured");
		theShader.compileProgram(fShaderCode, vShaderCode);
		theShader.defineAttribute("a_vertexPos", 3, "FLOAT");
		theShader.defineAttribute("a_uvCoords", 2, "FLOAT");
		theShader.defineAttribute("a_baryCoords", 3, "FLOAT");
		theShader.defineAttribute("a_wireframeColor", 3, "FLOAT");

		theShader.defineUniform("u_modelViewMatrix", inGL.uniformMatrix4fv);
		theShader.defineUniform("u_projectionMatrix", inGL.uniformMatrix4fv);
		theShader.defineUniform("u_textureSampler");
		theShader.uniforms["u_textureSampler"].glFunction = function(inGLLoc, inTexture) {
			// "this" will be the gl context

			// TODO I have absolutely no idea why I need the + 1
			// When this is called, asteroids have a bound texture idx = 0 and skyboxes have 1
			// If I don't have the 1, both asteroids and skyboxes use the skybox texture
			// If I do have the one, they each use their own respective texture
			this.activeTexture(inGL.TEXTURE0 + inTexture.boundTextureIdx + 1);
			this.uniform1i(inGLLoc, inTexture.boundTextureIdx);
		};
		theShader.defineUniform("u_wireframeThickness", inGL.uniform1f);

		ALL_SHADERS["textured"] = theShader;
	}
	// Textured Shader

} // createProgramAndShaders()

function loadAsteroid() {
	if (ALL_LOADED_TEXT.ICO_SPHERE.parsed == undefined)
		ALL_LOADED_TEXT.ICO_SPHERE.parsed = parseObj(ALL_LOADED_TEXT.ICO_SPHERE.loadedSrc);

	var drawable = new Drawable("Asteroid", ALL_LOADED_TEXT.ICO_SPHERE.parsed.clone(), ALL_SHADERS["textured"]);
	drawable.shaderConfig.uniforms["u_textureSampler"].args.push(ALL_LOADED_IMG["ASTEROID"]);

	drawable.shaderConfig.uniforms["u_wireframeThickness"].args.push(ASTEROID_WIREFRAME_THICKNESS);
	var rawColors = [];
	for (var vertIdx = 0; vertIdx < drawable.modelData.indexArray.length; vertIdx++) {
		rawColors = rawColors.concat(ASTEROID_WIREFRAME_COLOR);
	}
	drawable.shaderConfig.attributes["a_wireframeColor"].rawData = rawColors;
	drawable.shaderConfig.refreshAllBuffers();

	return drawable;
}

function loadPlayerShot() {
	if (ALL_LOADED_TEXT.SHOT.parsed == undefined)
		ALL_LOADED_TEXT.SHOT.parsed = parseObj(ALL_LOADED_TEXT.SHOT.loadedSrc);

	var drawable = new Drawable("Shot", ALL_LOADED_TEXT.SHOT.parsed.clone(), ALL_SHADERS["generic"]);

	var rawColors = [];
	for (var vertIdx = 0; vertIdx < drawable.modelData.indexArray.length; vertIdx++) {
		rawColors = rawColors.concat(PLAYER_SHOT_COLOR);
	}
	drawable.shaderConfig.attributes["a_vertexCol"].rawData = rawColors;
	drawable.shaderConfig.refreshAllBuffers();

	return drawable;
}

function loadPlayerShip() {
	ALL_LOADED_TEXT.PLAYER_SHIP.parsed = parseObj(ALL_LOADED_TEXT.PLAYER_SHIP.loadedSrc);
	var drawable = new Drawable("PlayerShip", ALL_LOADED_TEXT.PLAYER_SHIP.parsed.clone(), ALL_SHADERS["color_wireframe"]);

	// Find rear-middle vertex so we can colorize it differently...
	var rearVertexTriangleIndices = [];

	for (var vertIdx = 0; vertIdx < drawable.modelData.indexArray.length; vertIdx++) {
		var triangleVertexPosition = drawable.modelData.vertArray.slice(vertIdx * 3, (vertIdx + 1) * 3);
		if (triangleVertexPosition[0] == 0 && triangleVertexPosition[1] == 0 && triangleVertexPosition[2] < 0)
			rearVertexTriangleIndices.push(vertIdx);
	}

	drawable.modelData.rearVertexTriangleIndices = rearVertexTriangleIndices;
	// ...done finding rear-middle vertex so we can colorize it!

	drawable.shaderConfig.uniforms["u_wireframeThickness"].args.push(PLAYER_WIREFRAME_THICKNESS);
	var rawColors = [];
	for (var vertIdx = 0; vertIdx < drawable.modelData.indexArray.length; vertIdx++) {
		rawColors = rawColors.concat(PLAYER_WIREFRAME_COLOR);

		// Solid gray
		drawable.modelData.colorArray[(vertIdx*3)  ] = PLAYER_MODEL_COLOR[0];
		drawable.modelData.colorArray[(vertIdx*3)+1] = PLAYER_MODEL_COLOR[1];
		drawable.modelData.colorArray[(vertIdx*3)+2] = PLAYER_MODEL_COLOR[2];
	}
	drawable.shaderConfig.attributes["a_wireframeColor"].rawData = rawColors;
	drawable.shaderConfig.refreshAllBuffers();

	return drawable;
}

// #endregion Init Methods :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region Runtime Rendering Methods :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

function runtimeClearViewport() {
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	gl.clearColor(0, 0, 0, 0);
} // runtimeClearViewport();


var lastFrameTimeMs = -1;
const DELTATIME_LIMIT = 0.1; // s
const DELTATIME_AVERAGE = new RollingAverage(60);
function renderFrame(inHighPrecTimeMs) {
	// Calculate dT:
	if (typeof(inHighPrecTimeMs) != "number") throw `Browser does not support requestAnimationFrame passing a frame time! ${typeof(inHighPrecTimeMs)}`;
	var deltaTime = (inHighPrecTimeMs - lastFrameTimeMs) / 1000;
	deltaTime = Math.min(deltaTime, DELTATIME_LIMIT); // clamp it so freezes don't f up input
	DELTATIME_AVERAGE.push(deltaTime);
	lastFrameTimeMs = inHighPrecTimeMs;
	debugDrawText("deltaTime", `deltaTime: ${printFlt(deltaTime, 5)}s;\ntotalTime: ${printFlt(lastFrameTimeMs, 5)}ms`);
	// ...done calculating dT!

	updateGame(deltaTime);

	runtimeClearViewport();

	processInput(deltaTime);

	runtimeDrawSkybox();

	// Draw...
	for (var dbgDrawableIdx = 0; dbgDrawableIdx < dbgDrawables.length; dbgDrawableIdx++) {
		dbgDrawables[dbgDrawableIdx].draw(gl);
	}
	dbgDrawables = [];

	for (const persistGroup in dbgDrawablesPersist) {
		let group = dbgDrawablesPersist[persistGroup];
		for (var drawIdx = 0; drawIdx < group.length; drawIdx++) {
			group[drawIdx].draw(gl);
		}
	}

	for (var drawableIdx = 0; drawableIdx < drawables.length; drawableIdx++) {
		drawables[drawableIdx].draw(gl);
	}
	// ... done drawing!

	playerShipThrusterEffect();

	runtimeDrawUI();

	// Keep the loop alive
	if (IS_PAUSED == false) requestAnimationFrame(renderFrame);
} // end render triangles

function runtimeDrawSkybox() {
	const shaderConfig = SKYBOX.shaderConfig;
	const shader = shaderConfig.shader;

	gl.useProgram(shader.program);

	// Set up object uniforms:
	// SKYBOX.transform.transVec3 = CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3;
	var modelViewMat = mat4.create();
	mat4.multiply(modelViewMat, CAMERA.computed.viewMatrix, SKYBOX.transform.computeMatrix());

	// CAVEAT This assumes all shaders take these two params, which they probably do, but...
	gl.uniformMatrix4fv(shader.uniforms['u_modelViewMatrix'].location, false, new Float32Array(modelViewMat));
	// CAVEAT This only needs to be bound once per frame (if even that often!)
	gl.uniformMatrix4fv(shader.uniforms['u_projectionMatrix'].location, false, new Float32Array(CAMERA.computed.projMatrix));
	// ... done setting up object uniforms!

	SKYBOX.draw(gl);
} // runtimeDrawSkybox

function runtimeDrawUI() {
	uiCanvas.clearRect(0, 0, uiCanvas.canvas.width, uiCanvas.canvas.height);
	uiCanvas.fillStyle = 'white';
	uiCanvas.font = `${UI_TEXT_HEIGHT}px monospace`;

	// Left side...
	{
		var x = 10;
		var currentLine = 2;
		uiCanvas.textAlign = "left";
	
		uiCanvas.fillText(`SCORE: ${SCORE}`, x, (UI_LINE_HEIGHT * currentLine++));
		uiCanvas.fillText(`DIFFICULTY: ${DIFFICULTY}`, x, (UI_LINE_HEIGHT * currentLine++));
		uiCanvas.fillText(`# ROIDS: ${asteroids.length}`, x, (UI_LINE_HEIGHT * currentLine++));
		uiCanvas.fillText(`# LIVES: ${PLAYER_LIVES}`, x, (UI_LINE_HEIGHT * currentLine++));
	}
	// ...done with left side

	// Right side...
	{
		var x = 502;
		var currentLine = 2;
		uiCanvas.textAlign = "right";

		var dtAvg = DELTATIME_AVERAGE.getAverage();
		var fpsAvg = 1 / dtAvg;

		uiCanvas.fillText(`dT: ${dtAvg.toFixed(5)}s`, x, (UI_LINE_HEIGHT * currentLine++));
		uiCanvas.fillText(`FPS: ${fpsAvg.toFixed(2)}`, x, (UI_LINE_HEIGHT * currentLine++));
	}
	// ...done with right side
} // runtimeDrawUI

// #endregion Runtime Rendering Methods :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region Audio :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===
function audioPlayOneShot(inAudioName) {
	/** @type {AudioData} */
	let data = ALL_LOADED_AUDIO[inAudioName];
	let src = data.context.createBufferSource();
	src.buffer = data.buffer;
	src.connect(data.context.destination);
	src.start();
} // playSFX

function audioPlayerShot() {
	audioPlayOneShot("PLAYER_SHOT");
}

function audioAsteroidExplosion(inSize) {
	switch (inSize) {
		case 1: audioPlayOneShot("ASTEROID_EXPLOSION_SMALL"); break;
		case 2: audioPlayOneShot("ASTEROID_EXPLOSION_MEDIUM"); break;
		case 3: default: audioPlayOneShot("ASTEROID_EXPLOSION_LARGE"); break;
	}
}

/**
 * Some browsers disable audio playback on a page until the first user gesture
 */
function audioCheckAutoplayOnInput() {
	let introStub = ALL_LOADED_AUDIO["MUSIC_INTRO_STUB"];
	let fullMusic = ALL_LOADED_AUDIO["MUSIC"];

	if (introStub.context != undefined && introStub.context.state == "suspended") {
		if (fullMusic.context == undefined || fullMusic.context.state == "suspended") {
			console.warn(`Detected intro stub playback was blocked by browser auto-start rules; starting now!`);
			introStub.context.resume();
		}
	}
}
// #endregion Audio :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===



// #region ASTEROIDS Gameplay Logic :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

// #region ASTEROIDS Classes :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===
/**
 * @typedef {Object} Asteroid
 * @property {string} name
 * @property {number} size
 * @property {Drawable} drawable 
 * @property {number} collisionRadius 
 * @property {vec3} velocityVec3
 */

/**
 * @typedef {Object} PlayerShip
 * @property {string} name
 * @property {Drawable} drawable 
 * @property {number} collisionRadius 
 * @property {vec3} velocityVec3
 */

/**
 * @typedef {Object} PlayerShot
 * @property {string} name
 * @property {number} expireTime Time (ms) at which we will destroy this shot
 * @property {Drawable} drawable 
 * @property {number} collisionRadius 
 * @property {vec3} velocityVec3
 */
// #endregion ASTEROIDS Classes :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

// #region ASTEROIDS Config :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===
const ASTEROID_WIREFRAME_THICKNESS = 0.005;
const ASTEROID_WIREFRAME_COLOR = [1, 1, 1];

const PLAYER_WIREFRAME_THICKNESS = 0.04;
const PLAYER_WIREFRAME_COLOR = [0, 1, 0];
const PLAYER_MODEL_COLOR = [0.2, 0.2, 0.2];
const PLAYER_THRUSTER_COLOR = [1, 0.6, 0.2];
/** Time (s) for the player's thruster effect to lerp */
const PLAYER_THRUSTER_TIME = 0.6;
/** Roughly how quick (1/s) the ship will stabilize (i.e. zero-out velocity) */
const PLAYER_STABILIZE_RATE = 3;


const NUM_ASTEROIDS_BASE = 128;
/** Each 100 points, add this to difficulty level */
const DIFFICULTY_SCALING = 0.25;

/** How far out in each direction from the player to spawn new asteroids */
const ASTEROID_SPAWN_BOUNDS = [5, 20];

const ASTEROID_DESPAWN_DIST = 30;

/** Min and max velocity (per component) for new asteroids */
const ASTEROID_VELOCITY_BOUNDS = [0.01, 0.5];

const PLAYER_SPEED = {
	"forward": 5,
	"pitch": 2,
	"roll": 3,
	"yaw": 3,
	/** Shots per second when fire is held down - doesn't apply to rapid taps! */
	"shoot": 7
} // PLAYER_SPEED

const PLAYER_SHOT_FWD_DIST = 0.25;
const PLAYER_SHOT_SPEED = 12;
const PLAYER_SHOT_COLOR = [0.2, 1, 0.2];
const PLAYER_SHOT_LIFETIME = 3;
const PLAYER_SHOT_RADIUS = 0.05;

const PLAYER_LIVES_BASE = 3;
/** Add a new life every X points */
const PLAYER_LIFE_SCORE = 200;
/** How long (s) to wait before respawning the player */
const PLAYER_RESPAWN_WAIT = 2;

// #endregion ASTEROIDS Config :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

// #region ASTEROIDS State :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

/** Updated on asteroid destruction; `floor(NUM_ASTEROIDS_BASE * DIFFICULTY)` */
var NUM_ASTEROIDS_TARGET = NUM_ASTEROIDS_BASE;
/** TOTAL number of shots, ever */
var NUM_SHOTS = 0;

var SCORE = 0;
/** Updated on asteroid destruction; `1 + ( floor(Score / 100) * DIFFICULTY_SCALING )` */
var DIFFICULTY = 1;
var DIFFICULTY_OVERRIDE = Number.NaN;

/** @type {number} Fire if lastFrameTimeMs > this value. Uses PLAYER_SPEED.fire. */
var NEXT_SHOT_TIME = 0;
var WAS_FIRING_LAST_FRAME = false;

var PLAYER_THRUSTER_LERP_TIME = 0;
var PLAYER_THRUSTER_LERPED_COLOR = PLAYER_THRUSTER_COLOR;

/** @type {PlayerShip} */
var CONTROLLED_PLAYER_SHIP = undefined;
var PLAYER_LIVES = PLAYER_LIVES_BASE;
/** When (in game time) should the player respawn (because they totes died) */
var PLAYER_RESPAWN_AT = 0;
var PLAYER_RESPAWN_LOCATION = vec3.create();
var PLAYER_RESPAWN_ROTATION = quat.create();

/** @type {PlayerShot[]} All shots, from oldest to newest */
var shots = [];

/** @type {Asteroid[]} All asteroids, from oldest to newest */
var asteroids = [];
// #endregion ASTEROIDS State :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

function processInput(inDeltaTime) { 
	CAMERA.processInput(inDeltaTime);

	if (CONTROLLED_PLAYER_SHIP == undefined) return;

	var playerXform = CONTROLLED_PLAYER_SHIP.drawable.transform;
	var dbgString = "";
	var hadInput = false;

	if (INPUT.up != 0) {
		hadInput = true;
		var rotAmount = INPUT.up * PLAYER_SPEED.pitch * inDeltaTime;
		quat.rotateX(playerXform.rotQuat, playerXform.rotQuat, rotAmount);
		dbgString += `\n- UP: ${INPUT.up}->${rotAmount.toFixed(2)}`;
	}

	if (INPUT.roll != 0) { 
		hadInput = true;
		var rotAmount = INPUT.roll * PLAYER_SPEED.roll * inDeltaTime;
		quat.rotateZ(playerXform.rotQuat, playerXform.rotQuat, rotAmount);
		dbgString += `\n- ROLL: ${INPUT.roll}->${rotAmount.toFixed(2)}`;
	}

	if (INPUT.yaw != 0) { 
		hadInput = true;
		var rotAmount = INPUT.yaw * PLAYER_SPEED.yaw * inDeltaTime;
		quat.rotateY(playerXform.rotQuat, playerXform.rotQuat, rotAmount);
		dbgString += `\n- YAW: ${INPUT.yaw}->${rotAmount.toFixed(2)}`;
	}

	if (INPUT.forward != 0) {
		hadInput = true;
		var fwdAmount = INPUT.forward * PLAYER_SPEED.forward * inDeltaTime;

		var fwd = vec3.fromValues(0, 0, fwdAmount);
		vec3.transformQuat(fwd, fwd, playerXform.rotQuat);
		vec3.add(CONTROLLED_PLAYER_SHIP.velocityVec3, CONTROLLED_PLAYER_SHIP.velocityVec3, fwd);

		dbgString += `\n- FWD: ${INPUT.forward}`;
	}
	// Update thruster color effect
	{
		PLAYER_THRUSTER_LERP_TIME += (INPUT.forward > 0 ? 1 : -1) * (1/PLAYER_THRUSTER_TIME) * inDeltaTime;
		PLAYER_THRUSTER_LERP_TIME = clamp(PLAYER_THRUSTER_LERP_TIME, 0, 1);
		PLAYER_THRUSTER_LERPED_COLOR = [
			lerp(PLAYER_MODEL_COLOR[0], PLAYER_THRUSTER_COLOR[0], PLAYER_THRUSTER_LERP_TIME),
			lerp(PLAYER_MODEL_COLOR[1], PLAYER_THRUSTER_COLOR[1], PLAYER_THRUSTER_LERP_TIME),
			lerp(PLAYER_MODEL_COLOR[2], PLAYER_THRUSTER_COLOR[2], PLAYER_THRUSTER_LERP_TIME)
		];

		dbgString += `\n-LERP TIME=${PLAYER_THRUSTER_LERP_TIME}; COLOR=${PLAYER_THRUSTER_LERPED_COLOR}`;
	}
	// ...done updating thruster color effect

	if (INPUT.stabilize != 0) {
		hadInput = true;
		var stabAmount = inDeltaTime * PLAYER_STABILIZE_RATE;
		// var velocityMag = vec3.length(CONTROLLED_PLAYER_SHIP.velocityVec3);
		// lerp(velocityMag, vec3.fromValues(0, 0, 0), stabAmount);

		CONTROLLED_PLAYER_SHIP.velocityVec3[0] = lerp(CONTROLLED_PLAYER_SHIP.velocityVec3[0], 0, stabAmount);
		CONTROLLED_PLAYER_SHIP.velocityVec3[1] = lerp(CONTROLLED_PLAYER_SHIP.velocityVec3[1], 0, stabAmount);
		CONTROLLED_PLAYER_SHIP.velocityVec3[2] = lerp(CONTROLLED_PLAYER_SHIP.velocityVec3[2], 0, stabAmount);

	}

	if (INPUT.fire != 0) {
		// Don't set hadInput true, this isn't relevant for the camera.
		WAS_FIRING_LAST_FRAME = true;
		if (lastFrameTimeMs > NEXT_SHOT_TIME) {
			// Cooldown complete - fire!
			NEXT_SHOT_TIME = lastFrameTimeMs + ((1 / PLAYER_SPEED.shoot) * 1000);
			newPlayerShot();
			audioPlayerShot();
		}
	} else if (WAS_FIRING_LAST_FRAME = true) {
		// Player has released spacebar. Go ahead and clear the NEXT_SHOT_TIME so they immediately fire next keypress.
		NEXT_SHOT_TIME = 0;
	}

	if (dbgString.length > 0)
		debugDrawText("processInput", `PLAYER INPUT: ${dbgString}`);
}

function newPlayerShot() {
	var playerXform = CONTROLLED_PLAYER_SHIP.drawable.transform;

	var location = vec3.fromValues(0, 0, PLAYER_SHOT_FWD_DIST); // in front of player
	vec3.transformQuat(location, location, playerXform.rotQuat);
	vec3.add(location, location, playerXform.transVec3);

	var rotation = quat.clone(playerXform.rotQuat);

	var velocity = vec3.fromValues(0, 0, PLAYER_SHOT_SPEED); // in front of player
	vec3.transformQuat(velocity, velocity, playerXform.rotQuat);
	vec3.add(velocity, velocity, CONTROLLED_PLAYER_SHIP.velocityVec3);

	var drawable = loadPlayerShot();
	drawable.transform.transVec3 = location;
	drawable.transform.rotQuat = rotation;
	var obj = new GameObject(EObjectTypes.Shot, drawable, PLAYER_SHOT_RADIUS, `Shot_${NUM_SHOTS++}`, velocity);
	obj.expireTime = lastFrameTimeMs + (PLAYER_SHOT_LIFETIME * 1000);
	gameObjectsPendingSpawn.push(obj);
	shots.push(obj);
 
	return obj;
} // newPlayerShot

function newPlayerShip(inLocVec3 = undefined) {
	var drawable = loadPlayerShip();
	var obj = new GameObject(EObjectTypes.Player, drawable, 0.05, "Player");
	gameObjectsPendingSpawn.push(obj);

	if (inLocVec3 != undefined)
		drawable.transform.transVec3 = vec3.clone(inLocVec3);

	CONTROLLED_PLAYER_SHIP = obj;
	CAMERA.xformConfig.parentTransform = CONTROLLED_PLAYER_SHIP.drawable.transform;

	if (SKYBOX != undefined)
		SKYBOX.transform.transVec3 = CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3;

	return obj;
}

function playerShipThrusterEffect() {
	if (CONTROLLED_PLAYER_SHIP == undefined) return;

	/** @type {number[]} Triangle index values (from indexArray) of the rear vertex */
	var triIndices = CONTROLLED_PLAYER_SHIP.drawable.modelData.rearVertexTriangleIndices;
	var colorArray = CONTROLLED_PLAYER_SHIP.drawable.modelData.colorArray;

	for (var idx = 0; idx < triIndices.length; idx++) {
		var triIdx = triIndices[idx];
		var triIdxOffset = triIdx * 3;
		colorArray[triIdxOffset  ] = PLAYER_THRUSTER_LERPED_COLOR[0];
		colorArray[triIdxOffset+1] = PLAYER_THRUSTER_LERPED_COLOR[1];
		colorArray[triIdxOffset+1] = PLAYER_THRUSTER_LERPED_COLOR[2];
	}
	CONTROLLED_PLAYER_SHIP.drawable.shaderConfig.refreshAttribData("a_vertexCol");
} // playerShipThrusterEffect

/**
 * @param {number} [inSize] How big the asteroid should be, with 1 being the smallest asteroid, 
 * @param {vec3} [inLocVec3] If not provided, it will be randomly generated
 * @param {vec3} [inVelVec3] If not provided, it will be randomly generated
 * @returns {Asteroid}
 */
function newAsteroid(inSize = 3, inLocVec3 = undefined, inVelVec3 = undefined) {
	if (CONTROLLED_PLAYER_SHIP == undefined) return undefined;

	// Randomly generate location if none provided...
	if (inLocVec3 == undefined) {
		var playerPos = CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3;
		inLocVec3 = vec3.clone(playerPos);

		var distance = randRange(ASTEROID_SPAWN_BOUNDS[0], ASTEROID_SPAWN_BOUNDS[1]);
		inLocVec3[2] += distance;
		
		vec3.rotateX(inLocVec3, inLocVec3, playerPos, randRange(0, PI2));
		vec3.rotateY(inLocVec3, inLocVec3, playerPos, randRange(0, PI2));
		vec3.rotateZ(inLocVec3, inLocVec3, playerPos, randRange(0, PI2));
	}
	// ...done randomly generating location if none provided

	// Randomly generate velocity if none provided...
	if (inVelVec3 == undefined) {
		inVelVec3 = vec3.fromValues(
			randPosNeg() * randRange(ASTEROID_VELOCITY_BOUNDS[0], ASTEROID_VELOCITY_BOUNDS[1]),
			randPosNeg() * randRange(ASTEROID_VELOCITY_BOUNDS[0], ASTEROID_VELOCITY_BOUNDS[1]),
			randPosNeg() * randRange(ASTEROID_VELOCITY_BOUNDS[0], ASTEROID_VELOCITY_BOUNDS[1]));
	}
	// ...done randomly generating velocity if none provided

	// Randomly generate rotation...
	let rotQuat = quat.create();
	quat.fromEuler(rotQuat, randRange(0, PI2), randRange(0, PI2), randRange(0, PI2));
	//...done randomly generating rotation!

	// Generate drawable...
	let noisedRet = generateNoisedRoid(inLocVec3, 1, 0.1);
	var roidDrawable = noisedRet[0];
	var actualScale = inSize * 0.8;
	roidDrawable.transform.scaleVec3 = vec3.fromValues(actualScale, actualScale, actualScale);
	roidDrawable.transform.rotQuat = rotQuat;
	let scaledCollisionRadius = Math.sqrt(noisedRet[1]) * actualScale;
	// ... done generating drawable

	// Generate object...
	/** @type {Asteroid} */
	var roidObject = new GameObject(EObjectTypes.Asteroid, roidDrawable, scaledCollisionRadius, `Roid_${asteroids.length}`, inVelVec3);
	roidObject.size = inSize;
	gameObjectsPendingSpawn.push(roidObject);
	asteroids.push(roidObject);
	// ... done generating object

	return roidObject;
} // newAsteroid


/**
 * @param {PlayerShot} inShot 
 * @param {Asteroid} inAsteroid 
 */
function onShotAsteroidCollision(inShot, inShotIdx, inAsteroid, inAsteroidIdx) {

	var scoreThousands = Math.trunc((SCORE % 10000) / 1000);
	var newAsteroidSizes = [];
	switch (inAsteroid.size) {
		case 1: 
			SCORE += 100;
			break;
		case 2:
			SCORE += 50;
			newAsteroidSizes = [1, 1];
			break;
		case 3:
		default:
			SCORE += 20;
			newAsteroidSizes = [Math.floor(randRange(1, 3)), Math.floor(randRange(1, 3))];
			break;
	} // switch on size

	var newScoreThousands = Math.trunc((SCORE % 10000) / 1000);
	if (newScoreThousands > scoreThousands) {
		console.log(`Player earned another life!`);
		PLAYER_LIVES++;
	}

	audioAsteroidExplosion(inAsteroid.size);

	updateDifficulty();

	for (let sizeIdx = 0; sizeIdx < newAsteroidSizes.length; sizeIdx++) {
		newAsteroid(newAsteroidSizes[sizeIdx], vec3.clone(inAsteroid.drawable.transform.transVec3));
	}

	deleteObject(inShot);
	shots.splice(inShotIdx, 1);
	deleteObject(inAsteroid);
	asteroids.splice(inAsteroidIdx, 1);
} // onShotAsteroidCollision

/** @param {Asteroid} inAsteroid */
function onPlayerAsteroidCollision(inAsteroid) {
	PLAYER_LIVES--;
	if (PLAYER_LIVES > 0) {
		PLAYER_RESPAWN_AT = lastFrameTimeMs + (PLAYER_RESPAWN_WAIT * 1000);
		PLAYER_RESPAWN_LOCATION = vec3.clone(CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3);
		PLAYER_RESPAWN_ROTATION = quat.clone(CONTROLLED_PLAYER_SHIP.drawable.transform.rotQuat);

		console.log(`Player died at time=${lastFrameTimeMs}! Will respawn at time=${PLAYER_RESPAWN_AT}, pos=${PLAYER_RESPAWN_LOCATION} with ${PLAYER_LIVES} lives left`);
	} else {
		console.log(`Game over!`);
	}

	deleteObject(CONTROLLED_PLAYER_SHIP);
	CONTROLLED_PLAYER_SHIP = undefined;
	audioAsteroidExplosion(3);
} // onPlayerAsteroidCollision

function updateDifficulty() {
	if (DIFFICULTY != undefined && isNaN(DIFFICULTY_OVERRIDE) == false)
		DIFFICULTY = DIFFICULTY_OVERRIDE;
	else
		DIFFICULTY = 1 + ( Math.floor(SCORE / 100) * DIFFICULTY_SCALING );

	NUM_ASTEROIDS_TARGET = Math.floor(NUM_ASTEROIDS_BASE * DIFFICULTY);
}

function updateGame(inDeltaTime) {
	var debugStr = `UPDATE ${gameObjects.length} OBJECTS (DT=${inDeltaTime.toFixed(4)})`;

	// Handle player spawning...
	if (CONTROLLED_PLAYER_SHIP == undefined && lastFrameTimeMs > PLAYER_RESPAWN_AT && PLAYER_LIVES > 0) {
		console.debug(`Respawn with ${PLAYER_LIVES} lives left`);
		newPlayerShip(PLAYER_RESPAWN_LOCATION);
		CONTROLLED_PLAYER_SHIP.drawable.transform.rotQuat = quat.clone(PLAYER_RESPAWN_ROTATION);
	}
	// ...done handling player spawning

	// Clean up old shots...
	if (shots.length > 0) {
		var numOldShots = 0;
		debugDrawText("oldestShot", `shots[0].expireTime = ${shots[0].expireTime}`);
		for (var shotIdx = 0; shotIdx < shots.length && shots[shotIdx].expireTime <= lastFrameTimeMs; shotIdx++) 
			numOldShots++
	
		if (numOldShots > 0) {
			for (let objIdx = 0; objIdx < numOldShots; objIdx++) {
				let obj = shots[objIdx];
				deleteObject(obj);
			}
			
			shots.splice(0, numOldShots);
		}
	}
	// ...done cleaning up old shots!

	// Update object position based on velocity
	for (let objIdx = 0; objIdx < gameObjects.length; objIdx++) {
		let obj = gameObjects[objIdx]; if (obj.enabled == false) continue;
		
		let scaledVelocity = vec3.clone(obj.velocityVec3);
		vec3.scale(scaledVelocity, scaledVelocity, inDeltaTime);

		// debugStr += `\n-  ${objIdx} (${obj.name}): ${obj.velocityVec3}->${scaledVelocity}`;

		vec3.add(obj.drawable.transform.transVec3, obj.drawable.transform.transVec3, scaledVelocity);
	} // foreach gameObject
	// ...done updating object position based on velocity

	// Detect player-collisions...
	if (CONTROLLED_PLAYER_SHIP != undefined)
	{
		var playerPos = CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3;
		var playerColRad = CONTROLLED_PLAYER_SHIP.collisionRadius;

		for (let roidIdx = 0; roidIdx < asteroids.length; roidIdx++) {
			let roidObj = asteroids[roidIdx]; if (roidObj.enabled == false) continue;
			let roidPos = roidObj.drawable.transform.transVec3;

			let dist = vec3.dist(playerPos, roidPos);

			// Check if asteroid is too far and should be despawned
			// TODO we still do this O(n) collision for this reason
			// Can we have the tree "follow"/grow in the direction of the player as they move?
			// Then clean up nodes that are too far away, despawning their children in the process?
			if (dist > ASTEROID_DESPAWN_DIST) {
				// console.log(`DESPAWN ASTEROID: ${dist} > ${ASTEROID_DESPAWN_DIST}`);
				deleteObject(roidObj);
				asteroids.splice(roidIdx, 1); roidIdx--;
				continue;
			}

			let didCollide = dist < (playerColRad + roidObj.collisionRadius);
			if (didCollide) {
				onPlayerAsteroidCollision(roidObj);
			}
		} // foreach asteroid
	}
	// ...done with player-asteroid collisions!

	// Detect shot-asteroid collisions...
	{
		for (let shotIdx = 0; shotIdx < shots.length; shotIdx++) {
			let shot = shots[shotIdx]; if (shot.enabled == false) continue;
			let shotPos = shot.drawable.transform.transVec3;

			let colliders = OCTREE_ROOT_NODE.checkCollisions(shot);
			for (let colliderIdx = 0; colliderIdx < colliders.length; colliderIdx++) {
				let colliderObj = colliders[colliderIdx];
				// TODO multiple collisions aren't handled...
				onShotAsteroidCollision(shot, shotIdx, colliderObj, asteroids.indexOf(colliderObj));
				shotIdx--; roidIdx--;
				break;
			}
		} // foreach shot
	}
	// ...done detecting shot-collisions


	// Handle pending spawns...
	for (let pendingIdx = 0; pendingIdx < gameObjectsPendingSpawn.length; pendingIdx++) {
		let obj = gameObjectsPendingSpawn[pendingIdx];
		obj.enabled = true;

		let drawableIdx = drawables.indexOf(obj.drawable);
		if (drawableIdx < 0) {
			drawables.push(obj.drawable);
		} else {
			console.error(`OBJECT PENDING SPAWN '${obj.name}' ALREADY HAS DRAWABLE IN DRAWABLES!`);
		}

		let objIdx = gameObjects.indexOf(obj);
		if (objIdx < 0) {
			gameObjects.push(obj);
		} else {
			console.error(`OBJECT PENDING SPAWN '${obj.name}' ALREADY IN GAMEOBJECTS!`);
		}
	} // foreach object pending spawn
	gameObjectsPendingSpawn = [];
	// ...done handling pending spawns!

	// Handle pending deletes...
	for (let pendingIdx = 0; pendingIdx < gameObjectsPendingDelete.length; pendingIdx++) {
		let obj = gameObjectsPendingDelete[pendingIdx];

		let drawableIdx = drawables.indexOf(obj.drawable);
		if (drawableIdx >= 0) {
			drawables.splice(drawableIdx, 1);
		} else {
			console.error(`OBJECT PENDING DELETE '${obj.name}' DRAWABLE NOT IN DRAWABLES COLLECTION!`);
		}

		let objIdx = gameObjects.indexOf(obj);
		if (objIdx >= 0) {
			gameObjects.splice(objIdx, 1);
		} else {
			console.error(`OBJECT PENDING DELETE '${obj.name}' NOT IN gameObjects COLLECTION!`);
		}
	} // foreach object pending delete
	resetPendingDelete();
	// ...done handling pending deletes!
	
	// Handle new asteroids...
	for (let newRoidIdx = 0; newRoidIdx < NUM_ASTEROIDS_TARGET - asteroids.length; newRoidIdx++) {
		newAsteroid();
	}
	// ...done handling new asteroids!

	// Update octree...
	let playerEscapedOctree = CONTROLLED_PLAYER_SHIP != undefined && OCTREE_ROOT_NODE != null && OCTREE_ROOT_NODE.intersects(CONTROLLED_PLAYER_SHIP) == false;
	if (OCTREE_UPDATE_NEXT < lastFrameTimeMs || playerEscapedOctree) {
		OCTREE_UPDATE_NEXT = lastFrameTimeMs + OCTREE_UPDATE_TIME_MS;

		let octreePos = [0, 0, 0];
		if (CONTROLLED_PLAYER_SHIP != undefined)
			vec3.copy(octreePos, CONTROLLED_PLAYER_SHIP.drawable.transform.transVec3);
		else if (OCTREE_ROOT_NODE != undefined)
			vec3.copy(octreePos, OCTREE_ROOT_NODE.center);

		if (playerEscapedOctree) {
			console.log(`Rebuild octree at ${octreePos} as the player is out of it's bounds!`);
		}

		// From what I understand about the octree, if I want to check if an object collides with anything in the tree
		// I first check it against objects in the root, then test against child node bounds, then recurse.
		// For this, I should avoid passing the list of all game objects, including the player and the shots, because
		// we only check for collisions against asteroids.
		OctreeNode.initializeTree(octreePos, asteroids.slice());
		if (DEBUG_DRAW_OCTREE) {
			dbgDrawablesPersist["OCTREE"] = [];
			debugDrawOctreeNodeRecursive(OCTREE_ROOT_NODE);
		}
	}
	// ...done updating octree!

	CAMERA.computeViewMatrix();

	debugDrawText("updateGame", debugStr);

	debugDrawText("roidCounter", `# ROIDS: ${asteroids.length}\n# ROIDS TGT: ${NUM_ASTEROIDS_TARGET}`);
	debugDrawText("shotCounter", `# SHOTS: ${shots.length}`);
} // updateGame

// #endregion ASTEROIDS Gameplay Logic :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

// #region Inputs/Events :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===
var INPUT = {
	"up": 0,
	"roll": 0,
	"yaw": 0,
	"forward": 0,
	"stabilize": 0,

	"fire": 0
} // INPUT

function bindInput() {
	const kbdRotSpeed = 15;

	document.body.onkeydown = function(event) {
		audioCheckAutoplayOnInput();
		switch (event.key) {
			// #region Ship Controls
			case "w": case "W": case "ArrowUp": INPUT.up = 1; break;
			case "s": case "S": case "ArrowDown": INPUT.up = -1; break;

			case "d": case "D": case "ArrowRight": INPUT.yaw = -1; break;
			case "a": case "A": case "ArrowLeft": INPUT.yaw = 1; break;

			case "q": case "Q": INPUT.roll = 1; break;
			case "e": case "E": INPUT.roll = -1; break;

			case "f": case "F": INPUT.stabilize = 1; break;

			case "Shift": INPUT.forward = 1; break;
			case "Control": INPUT.forward = -1; break;

			case " ": INPUT.fire = 1; break;
			// #endregion Ship Controls

			// #region Camera Controls
			// case "q": CAMERA.input.rotationDeg[1] = kbdRotSpeed; break;
			// case "e": CAMERA.input.rotationDeg[1] = -kbdRotSpeed; break;
			// #endregion Camera Controls

			default: console.debug(`Unrecognized KeyDown: "${event.key}" (${event.keyCode}, shift=${event.shiftKey})`);
		} // switch (event.key)
	}; // onkeydown function

	document.body.onkeyup = function(event) {
		audioCheckAutoplayOnInput();
		switch (event.key) {
			// #region Ship Controls
			case "w": case "W": case "ArrowUp": INPUT.up = 0; break;
			case "s": case "S": case "ArrowDown": INPUT.up = 0; break;

			case "d": case "D": case "ArrowRight": INPUT.yaw = 0; break;
			case "a": case "A": case "ArrowLeft": INPUT.yaw = 0; break;

			case "q": case "Q": INPUT.roll = 0; break;
			case "e": case "E": INPUT.roll = 0; break;

			case "f": case "F": INPUT.stabilize = 0; break;

			case "Shift": INPUT.forward = 0; break;
			case "Control": INPUT.forward = 0; break;

			case " ": INPUT.fire = 0; break;
			// #endregion Ship Controls

			// #region Camera Controls
			// case "q": CAMERA.input.rotationDeg[1] = 0; break;
			// case "e": CAMERA.input.rotationDeg[1] = 0; break;
			// #endregion Camera Controls
		} // switch (event.key)
	}; // onkeyup function

	// HACK: UI canvas sits on top of gl canvas
	var canvas = document.getElementById("uiCanvas");
	canvas.addEventListener('mousemove', onMouseMove);
	canvas.addEventListener('wheel', onMouseWheel);
} //bindInput()

function onPauseButton() {
	IS_PAUSED = !IS_PAUSED;
	document.getElementById("pauseResumeBtn").innerText = IS_PAUSED ? "RESUME" : "PAUSE";
	console.log(IS_PAUSED ? "PAUSED!" : "RESUMING!");
	if (IS_PAUSED == false) renderFrame(lastFrameTimeMs + 1.0 / 60.0);
}

/** @param {MouseEvent} inEvent */
function onMouseMove(inEvent) {
	audioCheckAutoplayOnInput();

	var isScrollWheelDown = (inEvent.buttons & 4 | inEvent.altKey);
	// debugDrawText("mouseMove", `X=${inEvent.movementX}, Y=${inEvent.movementY}, wheel down=${isScrollWheelDown}`);

	if (isScrollWheelDown) {
		CAMERA.input.rotationDeg[0] = inEvent.movementY;
		CAMERA.input.rotationDeg[1] = inEvent.movementX;
	}
}

/** @param {MouseEvent} inEvent */
function onMouseWheel(inEvent) {
	CAMERA.input.zoom += (inEvent.deltaY);
}
// #endregion Inputs/Events :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

var NOISE = undefined;
/** For whatever reason these noise generators break down after several uses, so regen every few 'roids */
let NOISE_USES = 0;
const NOISE_USES_MAX = 16;

/**
 * 
 * @param {vec3} inLocation 
 * @param {number} inNoiseSize 
 * @param {number} inNoiseImpact 
 * @returns {any[]} [drawable, maxExtentSq]
 */
function generateNoisedRoid(inLocation, inNoiseSize, inNoiseImpact) {
	if (NOISE == undefined || NOISE_USES > NOISE_USES_MAX) {
		NOISE = new SimplexNoise();
		NOISE_USES = 0;
	}
	NOISE_USES++;

	var asteroid = loadAsteroid();

	/** @type {number[]} */
	var vertices = asteroid.modelData.vertArray;

	// Keep track of the furthest outward vertex on the displaced mesh
	// Use that to generate the collision radius
	var maxExtentSq = 0;

	// Displacement is a "scale out from origin", i.e. add
	// or subtract depending on quadrant
	function applyNoiseToVertexComponent(inVertIdx, inComponentIdx, inNoiseAtPoint) {
		let arrayIdx = inVertIdx + inComponentIdx;
		let originalVal = vertices[arrayIdx];
		let directedNoise = inNoiseAtPoint * (originalVal > 0 ? 1 : -1);
		let noisedVal = originalVal + directedNoise;

		vertices[arrayIdx] = noisedVal;
		return noisedVal;
	}

	var noiseSize   = inNoiseSize;
	var noiseImpact = inNoiseImpact;

	var noiseOffset = [0,0,0]; //vec3.fromValues(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1));

	for (var vertTripleIdx = 0; vertTripleIdx < vertices.length; vertTripleIdx += 3) {
		var vert = vertices.slice(vertTripleIdx, vertTripleIdx + 3); // slice "end" is exclusive

		// (Single value)
		var noiseAtPoint = NOISE.noise3D(
			(noiseOffset[0] + vert[0]) * noiseSize,
			(noiseOffset[1] + vert[1]) * noiseSize,
			(noiseOffset[2] + vert[2]) * noiseSize);

		noiseAtPoint *= noiseImpact;

		vert[0] = applyNoiseToVertexComponent(vertTripleIdx, 0, noiseAtPoint);
		vert[1] = applyNoiseToVertexComponent(vertTripleIdx, 1, noiseAtPoint);
		vert[2] = applyNoiseToVertexComponent(vertTripleIdx, 2, noiseAtPoint);

		let vertExtentSq = vec3.squaredLength(vert);
		if (vertExtentSq > maxExtentSq) 
			maxExtentSq = vertExtentSq;
	} // foreach vert set

	// Refresh gl buffers since we operated on solely model data
	asteroid.transform.transVec3 = inLocation;
	asteroid.shaderConfig.refreshAllBuffers();

	return [asteroid, maxExtentSq];
} // generateNoisedRoid


function main() {
	debugDrawText("initStatus", "Loading up!");

	ALL_LOADED_TEXT.doLoad(onPreloadComplete);
	ALL_LOADED_AUDIO.doLoad(undefined, onAudioIntroStubLoaded);
	function onPreloadComplete() {
		CAMERA.computeViewMatrix();
		CAMERA.computeProjMatrix();

		setupUI();
		setupWebGL(); debugDrawText("initStatus", "WebGL initialized!");
		initializeShaders(gl); debugDrawText("initStatus", "Shaders Initialized!");
		
		ALL_LOADED_IMG.doLoad(gl);

		newPlayerShip();

		for (var roidIdx = 0; roidIdx < NUM_ASTEROIDS_TARGET; roidIdx ++ ) {
			newAsteroid();
		}

		bindInput(); debugDrawText("initStatus", "Input bound!");

		// Camera warmup...
		CAMERA.computeViewMatrix();
		CAMERA.computeProjMatrix(); debugDrawText("initStatus", "Camera setup!");

		setupSkybox();

		// Loops forever :o
		renderFrame(0); // draw the triangles using webGL
	} // onPreloadComplete (i.e. actual main)

	function onAudioIntroStubLoaded() {
		let data = ALL_LOADED_AUDIO["MUSIC_INTRO_STUB"];
		let src = data.context.createBufferSource();
		data.playbackNode = src;

		let gainNode = data.context.createGain();
		gainNode.connect(data.context.destination);
		gainNode.gain.setValueAtTime(0.5, 0);
		
		src.buffer = data.buffer;
		src.connect(gainNode);
		src.loop = false;
		src.start(0);
		src.onended = onAudioIntroStubPlaybackEnd;
	}

	function onAudioIntroStubPlaybackEnd() {
		const MAIN_TRACK_START_TIME = 60+59.241;
		console.log(`Intro music stub complete! Switching to main audio track [t=${MAIN_TRACK_START_TIME}]`);

		let data = ALL_LOADED_AUDIO["MUSIC"];
		let src = data.context.createBufferSource();
		data.playbackNode = src;

		let gainNode = data.context.createGain();
		gainNode.connect(data.context.destination);
		gainNode.gain.setValueAtTime(0.5, 0);
		
		src.buffer = data.buffer;
		src.connect(gainNode);
		src.loop = true;
		src.start(0, MAIN_TRACK_START_TIME);
	}

	debugControls();
} // end main
window.onload = main;

// #region Debug Helpers :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===

function debugDrawText(inID, inText) {
	var elem = document.getElementById(inID);
	if (elem == undefined) {
		var elemPara = document.createElement("p");
		var elemNode = document.createTextNode(inText);
		elemPara.appendChild(elemNode);
		
		var dbgDiv = document.getElementById("dbgLog");
		dbgDiv.appendChild(elemPara);
		
		elemPara.id = inID;
		elem = elemPara;
	}

	elem.innerText = inText;
} // debugDrawText


/** 
 * @param {GameObject} inGameObject
 * @returns {Drawable} Also pushes drawable to dbgDrawablesPersist["COLLISION"]
 */
function debugDrawCollision(inGameObject, inColor = [1, 0, 1]) {
	if (ALL_LOADED_TEXT.UV_SPHERE.parsed == undefined) {
		ALL_LOADED_TEXT.UV_SPHERE.parsed = parseObj(ALL_LOADED_TEXT.UV_SPHERE.loadedSrc);
	}

	var dbgSphereModelInst = ALL_LOADED_TEXT.UV_SPHERE.parsed.clone();

	// Apply colors...
	for (var idxTriplet = 0; idxTriplet < dbgSphereModelInst.colorArray; idxTriplet += 3) {
		dbgSphereModelInst.colorArray[idxTriplet]   = inColor[0];
		dbgSphereModelInst.colorArray[idxTriplet+1] = inColor[1];
		dbgSphereModelInst.colorArray[idxTriplet+2] = inColor[2];
	}
	// ...done applying color!

	var sphereDrawable = new Drawable("DbgSphere", dbgSphereModelInst, ALL_SHADERS["generic"]);
	sphereDrawable.alsoRenderWireframe = false;
	sphereDrawable.isDebug = true;

	sphereDrawable.transform.scaleVec3 = vec3.fromValues(inGameObject.collisionRadius, inGameObject.collisionRadius, inGameObject.collisionRadius);
	sphereDrawable.transform.transVec3 = inGameObject.drawable.transform.transVec3;

	sphereDrawable.shaderConfig.renderMode = sphereDrawable.shaderConfig.shader.glContext.LINE_LOOP;

	dbgDrawablesPersist["COLLISION"].push(sphereDrawable);
	return sphereDrawable;
} // debugDrawCollision

/** @param {OctreeNode} inOctreeNode */
function debugDrawOctreeNodeRecursive(inOctreeNode) {
	if (ALL_LOADED_TEXT.DBG_OCTREE_NODE.parsed == undefined)
		ALL_LOADED_TEXT.DBG_OCTREE_NODE.parsed = parseObj(ALL_LOADED_TEXT.DBG_OCTREE_NODE.loadedSrc);

	var drawable = new Drawable("OctreeNode", ALL_LOADED_TEXT.DBG_OCTREE_NODE.parsed.clone(), ALL_SHADERS["generic"]);
	drawable.transform.transVec3 = inOctreeNode.center;
	drawable.transform.scaleVec3 = [inOctreeNode.radius, inOctreeNode.radius, inOctreeNode.radius];
	drawable.shaderConfig.renderMode = drawable.shaderConfig.shader.glContext.LINES;
	dbgDrawablesPersist["OCTREE"].push(drawable);

	for (let childIdx = 0; childIdx < inOctreeNode.children.length; childIdx++)
		debugDrawOctreeNodeRecursive(inOctreeNode.children[childIdx]);
} // debugDrawOctreeNodeRecursive

/** @param {boolean} inValue */
function debugDrawCollisionToggle(inValue) {
	dbgDrawablesPersist["COLLISION"] = [];
	DEBUG_DRAW_COLLISION = inValue;
	if (DEBUG_DRAW_COLLISION) {
		for (let objIdx = 0; objIdx < gameObjects.length; objIdx++) {
			let gameObject = gameObjects[objIdx];
			if (gameObject != undefined && gameObject.enabled)
				debugDrawCollision(gameObject);
		}
	} else { // disabled
		// already cleared the list, so...
	}
} // debugDrawCollisionToggle


/**
 * Creates new html elements for debug controls
 */
function debugControls() {
	var div = document.getElementById("dbgCtrls");

	var diffLabel = document.createElement("p");
	diffLabel.textContent = "DIFFICULTY OVERRIDE";
	div.appendChild(diffLabel);
	var diffEntry = document.createElement("input");
	diffEntry.min = 1;
	diffEntry.max = 10;
	diffEntry.id = `${div.id}_controlDifficulty`;
	diffEntry.onchange = function() {
		DIFFICULTY_OVERRIDE = Number.parseFloat(diffEntry.value);
		updateDifficulty();
		console.log(`DEBUG CONTROLS: Set difficulty to ${DIFFICULTY_OVERRIDE}`);
	}
	div.appendChild(diffEntry);

	// #region Octree Controls
	{
		let ctrlDiv = document.createElement("div"); 
		ctrlDiv.id = "dbgOctreeControls";
		
		var hdrTxt = document.createElement("h4");
		hdrTxt.innerText = "OCTREE CONTROLS:";
		ctrlDiv.appendChild(hdrTxt);

		var toggleDrawBtn = document.createElement("button");
		toggleDrawBtn.id = `${ctrlDiv.id}_toggleDraw`;
		ctrlDiv.appendChild(toggleDrawBtn);
		toggleDrawBtn.innerText = `TOGGLE DRAW`;
		toggleDrawBtn.onclick = function() {
			DEBUG_DRAW_OCTREE = !DEBUG_DRAW_OCTREE;
			console.debug(`DEBUG CONTROLS: Toggle DEBUG_DRAW_OCTREE to ${DEBUG_DRAW_OCTREE}`);

			if (DEBUG_DRAW_OCTREE == false) {
				dbgDrawablesPersist["OCTREE"] = [];
			}
		}

		div.appendChild(ctrlDiv);
	}
	// #endregion Octree Controls

	// spawnRandomAsteroid
	if (false)
	{
		var ctrlDiv = document.createElement("div"); 
		ctrlDiv.id = "spawnRandomAsteroid";
		{
			var hdrTxt = document.createElement("h4");
			hdrTxt.innerText = "SPAWN DISPLACED ASTEROID:";
			ctrlDiv.appendChild(hdrTxt);

			var locTxt = document.createElement("p");
			locTxt.innerText = `Location ("x, y, z"):`;
			ctrlDiv.appendChild(locTxt);
			var locInp = document.createElement("input");
			locInp.id = `${ctrlDiv.id}.locInp`;
			locInp.value = "0, 0, 0";
			ctrlDiv.appendChild(locInp);

			var scaleTxt = document.createElement("p");
			scaleTxt.innerText = `Scale (universal x,y, and z):`;
			ctrlDiv.appendChild(scaleTxt);
			var scaleInp = document.createElement("input");
			scaleInp.id = `${ctrlDiv.id}.scaleInp`;
			scaleInp.value = "1";
			ctrlDiv.appendChild(scaleInp);

			var noiseSizeTxt = document.createElement("p");
			noiseSizeTxt.innerText = `Noise Size (0.001-50):`;
			ctrlDiv.appendChild(noiseSizeTxt);
			var noiseSizeInp = document.createElement("input");
			noiseSizeInp.id = `${ctrlDiv.id}.noiseSizeInp`;
			noiseSizeInp.value = "10";
			ctrlDiv.appendChild(noiseSizeInp);
			
			var noiseImpactTxt = document.createElement("p");
			noiseImpactTxt.innerText = `Noise Impact (0.001-1):`;
			ctrlDiv.appendChild(noiseImpactTxt);
			var noiseImpactInp = document.createElement("input");
			noiseImpactInp.id = `${ctrlDiv.id}.noiseImpactInp`;
			noiseImpactInp.value = "0.02";
			ctrlDiv.appendChild(noiseImpactInp);

			var wireframeColTxt = document.createElement("p");
			wireframeColTxt.innerText = `Wireframe Color [r,g,b] [0-1]:`;
			ctrlDiv.appendChild(wireframeColTxt);
			var wireframeColInp = document.createElement("input");
			wireframeColInp.id = `${ctrlDiv.id}.wireframeColInp`;
			wireframeColInp.value = "1, 1, 1";
			ctrlDiv.appendChild(wireframeColInp);

			var wireframeThicknessTxt = document.createElement("p");
			wireframeThicknessTxt.innerText = `Wireframe Thickness [0-1]:`;
			ctrlDiv.appendChild(wireframeThicknessTxt);
			var wireframeThicknessInp = document.createElement("input");
			wireframeThicknessInp.id = `${ctrlDiv.id}.wireframeThicknessInp`;
			wireframeThicknessInp.value = "0.02";
			ctrlDiv.appendChild(wireframeThicknessInp);

			var submit = document.createElement("button");
			submit.id = `${ctrlDiv.id}.submit`;
			submit.innerText = `CREATE 'ROID`;
			submit.onclick = function() {
				var locSplit = locInp.value.split(",");
				var loc = vec3.fromValues(Number.parseFloat(locSplit[0]), Number.parseFloat(locSplit[1]), Number.parseFloat(locSplit[2]));

				var scale = Number.parseFloat(scaleInp.value);

				var noiseSize = Number.parseFloat(noiseSizeInp.value);
				var noiseImpact = Number.parseFloat(noiseImpactInp.value);

				var wColSplit = wireframeColInp.value.split(",");
				ASTEROID_WIREFRAME_COLOR = [Number.parseFloat(wColSplit[0]), Number.parseFloat(wColSplit[1]), Number.parseFloat(wColSplit[2])];
				ASTEROID_WIREFRAME_THICKNESS = Number.parseFloat(wireframeThicknessInp.value);

				console.log(`Create asteroid with pos=${loc}, size=${noiseSize}, imp=${noiseImpact}, wC=${ASTEROID_WIREFRAME_COLOR}, wT=${ASTEROID_WIREFRAME_THICKNESS}`);


				var roid = generateNoisedRoid(loc, noiseSize, noiseImpact);
				roid.transform.scaleVec3 = vec3.fromValues(scale, scale, scale);
			}
			ctrlDiv.appendChild(submit);
		}
		div.appendChild(ctrlDiv);
	}
	// spawnRandomAsteroid
} // debugControls

// #endregion Debug Helpers :===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===:===