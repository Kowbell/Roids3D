export const EObjectTypes = {"Asteroid": 1, "Player": 2, "Shot": 3};

export let gameObjectsPendingDelete = [];

/**
 * Next frame, remove the object from gameObjects and it's drawable from drawables
 * @param {GameObject} inGameObject 
 */
export function deleteObject(inGameObject) {
	inGameObject.enabled = false;

	var pendingIdx = gameObjectsPendingDelete.indexOf(inGameObject)
	if (pendingIdx < 0) {
		gameObjectsPendingDelete.push(inGameObject);
	} else {
		console.warn(`Object '${inGameObject.name}' already queued for delete (idx=${pendingIdx})`);
	}
}

/**
 * Bit of a hack for now. Since we want to splice deleted objects from the
 * drawables/gameObjects arrays, we have to do the actual "deletion" in main.js
 * for now.
 */
export function resetPendingDelete() {
	gameObjectsPendingDelete = [];
}