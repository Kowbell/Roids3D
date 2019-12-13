/** Radius (game units, not nodes) of the tree root */
const OCTREE_NODE_ENCLOSE_SIZE = 32;
/** Stop subdividing if the octree node has this many objects (or fewer) */
const OCTREE_NODE_MIN_OBJ = 1;
/** Stop subdividing if the octree node extents are <= this */
const OCTREE_NODE_MIN_RADIUS = 0.1;

/** Only update the octree this often */
const OCTREE_UPDATE_TIME_MS = 250;

/** @type {OctreeNode} Assigned in OctreeNode.initializeTree() */
let OCTREE_ROOT_NODE = undefined;
/** @type {number} Maximum depth of the current tree, mainly for logging */
let OCTREE_DEPTH = 0;
/** @type {number} Current number of octree nodes, mainly for logging */
let OCTREE_NODE_COUNT = 0;

/** Next time to update the tree (ms) */
let OCTREE_UPDATE_NEXT = 0;

/**
 * Recursive tree node containing at least OCTREE_NODE_MIN_OBJ objects and at least OCTREE_NODE_MIN_RADIUS units in radius
 * For now when we need to rebuild we completely rebuild the entire tree
 * Shout out to Eric Nevala, https://www.gamedev.net/articles/programming/general-and-gameplay-programming/introduction-to-octrees-r3529/
 */
class OctreeNode {
	/**
	 * @param {vec3} inCenter 
	 * @param {number} inRadius How far out from the center in each direction we extend
	 * @param {OctreeNode} inParent 
	 * @param {GameObject[]} inObjects Objects that will be in this node (or it's children)
	 */
	constructor(inCenter, inRadius, inParent, inObjects) {
		/** @type {vec3} */
		this.center = inCenter;
		/** @type {number} How far out from the center in each direction we extend */
		this.radius = inRadius;

		/** @type {vec3} Calculated from center and radius at construction*/
		this.extentMin = vec3.fromValues(this.center[0] - this.radius, this.center[1] - this.radius, this.center[2] - this.radius);
		/** @type {vec3} Calculated from center and radius at construction*/
		this.extentMax = vec3.fromValues(this.center[0] + this.radius, this.center[1] + this.radius, this.center[2] + this.radius);

		/** @type {OctreeNode} */
		this.parent = inParent;
		this.depth = this.parent != undefined ? this.parent.depth + 1 : 0;
		if (this.depth > OCTREE_DEPTH) OCTREE_DEPTH = this.depth;

		/** @type {OctreeNode[]} Subdivided nodes */
		this.children = [];

		/** @type {GameObject[]} Objects neatly contained within this node (excluding any in children) */
		this.objects = inObjects != undefined ? inObjects : [];

		// console.debug(`New octree node at pos=${this.center}, rad=${this.radius}, depth=${this.depth}, objs=${this.objects.length}`);
	}

	/**
	 * @param {GameObject} inGameObject 
	 * @returns {boolean} true only if the entire object fits within this node
	 */
	contains (inGameObject, inEvenIfDisabled = false) {
		if (inGameObject.enabled == false && inEvenIfDisabled == false)
			return false;

		let objPos = inGameObject.drawable.transform.transVec3;
		let objRad = inGameObject.collisionRadius;
		
		let contains = true;
		// Check x,y,z max
		contains &= objPos[0] + objRad <= this.extentMax[0];
		contains &= objPos[1] + objRad <= this.extentMax[1];
		contains &= objPos[2] + objRad <= this.extentMax[2];
		// Check x,y,z min
		contains &= objPos[0] - objRad >= this.extentMin[0];
		contains &= objPos[1] - objRad >= this.extentMin[1];
		contains &= objPos[2] - objRad >= this.extentMin[2];

		return contains;
	} // contains()

	/**
	 * @param {GameObject} inGameObject 
	 * @returns {boolean} true if the object overlaps with this node even a little bit
	 */
	 intersects (inGameObject, inEvenIfDisabled = false) {
		if (inGameObject.enabled == false && inEvenIfDisabled == false)
			return false;

		let objPos = inGameObject.drawable.transform.transVec3;
		let objRad = inGameObject.collisionRadius;
		
		let contains = true;
		// Check x,y,z max
		contains |= objPos[0] + objRad <= this.extentMax[0];
		contains |= objPos[1] + objRad <= this.extentMax[1];
		contains |= objPos[2] + objRad <= this.extentMax[2];
		// Check x,y,z min
		contains |= objPos[0] - objRad >= this.extentMin[0];
		contains |= objPos[1] - objRad >= this.extentMin[1];
		contains |= objPos[2] - objRad >= this.extentMin[2];

		return contains;
	} // intersects()

	/**
	 * Recursive method which recalculates the octree
	 */
	buildTree() {
		if (this.objects.length <= OCTREE_NODE_MIN_OBJ) {
			// console.debug(`Stopping build at node with depth=${this.depth} - too few children!`);
			return;
		}

		if (this.radius <= OCTREE_NODE_MIN_RADIUS){
			// console.debug(`Stopping build at node with depth=${this.depth} - radius too small!`);
			return;
		}

		// #region Octants data setup

		function octantContains(inGameObject, inCenterVec3, inRadius) {
			let objPos = inGameObject.drawable.transform.transVec3;
			let objRad = inGameObject.collisionRadius;
	
			let contains = inGameObject.enabled;
			// Check x,y,z max
			contains &= objPos[0] + objRad <= inCenterVec3[0] + inRadius;
			contains &= objPos[1] + objRad <= inCenterVec3[1] + inRadius;
			contains &= objPos[2] + objRad <= inCenterVec3[2] + inRadius;
			// Check x,y,z min
			contains &= objPos[0] - objRad >= inCenterVec3[0] - inRadius;
			contains &= objPos[1] - objRad >= inCenterVec3[1] - inRadius;
			contains &= objPos[2] - objRad >= inCenterVec3[2] - inRadius;
	
			return contains;
		} // octantContains

		// Radius of each child
		const x = this.center[0]; const y = this.center[1]; const z = this.center[2];
		const r = this.radius / 2;

		/** Think of each index as the 3-bit value, with x being left-most bit, and 0 being negative
		 * ```
		 *     idx   bit   xyz
		 *     [0] = 000 = ---
		 *     [1] = 001 = --+
		 *     [2] = 010 = -+-
		 *     [3] = 011 = -++
		 *     [4] = 100 = +--
		 *     [5] = 101 = +-+
		 *     [6] = 110 = ++-
		 *     [7] = 111 = +++
		 *     idx   bit   xyz
		 * ``` */
		let octantCenters = [
			[ x - r , y - r , z - r ],
			[ x - r , y - r , z + r ],
			[ x - r , y + r , z - r ],
			[ x - r , y + r , z + r ],
			[ x + r , y - r , z - r ],
			[ x + r , y - r , z + r ],
			[ x + r , y + r , z - r ],
			[ x + r , y + r , z + r ],
		];

		/** @type {GameObject[][]} Each octant's contained objects */
		let octantObjects = [ [], [], [], [], [], [], [], [] ];
		/** @type {number[]} Indices for all objects that are in octantObjects */
		let removedObjIndices = [];
		// #endregion Octants data setup

		// #region Check which objects fit into which octants
		for (let objIdx = 0; objIdx < this.objects.length; objIdx++) {
			let obj = this.objects[objIdx];

			for (let octIdx = 0; octIdx < 8; octIdx++) {
				let octant = octantCenters[octIdx];

				if (octantContains(obj, octant, r)) {
					octantObjects[octIdx].push(obj);
					removedObjIndices.push(objIdx);
				}
			}
		}
		// #endregion Check which objects fit into which octants

		// #region Make child nodes for non-empty octants, pop objects from our list
		for (let octIdx = 0; octIdx < 8; octIdx++) {
			let center = octantCenters[octIdx];
			let objects = octantObjects[octIdx];
			if (objects == undefined || objects.length == 0) continue;

			let childNode = new OctreeNode(center, r, this, objects);
			this.children.push(childNode);
			OCTREE_NODE_COUNT++;
		}

		for (let rmObjIdx = 0; rmObjIdx < removedObjIndices.length; rmObjIdx++) {
			this.objects.splice(rmObjIdx, 1);
		}
		// #endregion Make child nodes for non-empty octants, pop objects from our list

		// Recurse:
		// console.debug(`Node at depth=${this.depth} has ${this.children.length} children and ${this.objects.length} objects!`);
		for (let childIdx = 0; childIdx < this.children.length; childIdx++)
			this.children[childIdx].buildTree();
		
	} // buildTree()

	/**
	 * Recursively checks for collisions against any objects within this node or its children.
	 *
	 * @param {GameObject} inGameObject 
	 * @param {GameObject[]} inColliders This will be passed to recursive calls so we're all adding to the same list; eventually we return it
	 * @returns {GameObject[]} any objects which inGameObject collides with
	 */
	checkCollisions(inGameObject, inColliders = []) {
		// #region Check against objects in this node (and not in children)
		for (let containedIdx = 0; containedIdx < this.objects.length; containedIdx++) {
			let nodeObject = this.objects[containedIdx];
			// We don't update the tree every frame or even after every object is destroyed,
			// so we may need to do extra cleanup now:
			if (nodeObject == undefined || nodeObject.enabled == false) {
				this.objects.splice(containedIdx);
				containedIdx--;
				continue;
			}

			if (inGameObject.checkCollision(nodeObject) == true) {
				inColliders.push(nodeObject);
			}
		}
		// #endregion Check against objects in this node (and not in children)

		// #region Check against children and recurse
		for (let nodeIdx = 0; nodeIdx < this.children.length; nodeIdx++) {
			let node = this.children[nodeIdx];
			if (node.intersects(inGameObject) == true) {
				node.checkCollisions(inGameObject, inColliders);
			}
		}
		// #endregion Check against children and recurse

		return inColliders;
	} // checkCollisions()

	static initializeTree(inRootCenter, inObjects) {
		let startTime = window.performance.now();
		OCTREE_DEPTH = 0; OCTREE_NODE_COUNT = 1;
		OCTREE_ROOT_NODE = new OctreeNode(inRootCenter, OCTREE_NODE_ENCLOSE_SIZE, undefined, inObjects);
		OCTREE_ROOT_NODE.buildTree();
		let stopTime = window.performance.now();
		// console.debug(`Octree built in ${stopTime - startTime}ms! # objs = ${inObjects.length}, # nodes = ${OCTREE_NODE_COUNT}, depth = ${OCTREE_DEPTH}...`);
	}
} // OctreeNode