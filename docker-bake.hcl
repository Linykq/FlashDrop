# The two images of the stack (design §2, §14), built from the repo root:
#
#   docker buildx bake --load     both targets, into the local image store (`pnpm stack:up` runs this)
#   docker buildx bake --print    the resolved build definition
#
# compose.yaml runs them as flashdrop/node:<IMAGE_TAG> (migrate, api-1, api-2, worker) and
# flashdrop/web:<IMAGE_TAG>.
# Always pass `--load` (bake-action: `load: true`): with the docker-container driver, a build without it
# stays in the builder's cache, and Compose, which never pulls these images, finds nothing to run.
#
# GitHub Actions: the layer cache goes to the Actions cache, one scope per target, with mode=max so the
# dependency-install stages are cached as well. type=gha needs the runtime token that docker/bake-action
# exposes (for a plain `run: docker buildx bake`, crazy-max/ghaction-github-runtime does it).

variable "IMAGE_TAG" {
  default = "dev"
}

# Directories under apps/ bundled into the node image (Dockerfile.node). payment-mock joins here in M4.
variable "NODE_APPS" {
  default = "api worker"
}

# GitHub Actions sets GITHUB_ACTIONS=true; bake reads it from the environment.
variable "GITHUB_ACTIONS" {
  default = "false"
}

function "cache_from" {
  params = [scope]
  result = GITHUB_ACTIONS == "true" ? ["type=gha,scope=${scope}"] : []
}

function "cache_to" {
  params = [scope]
  result = GITHUB_ACTIONS == "true" ? ["type=gha,scope=${scope},mode=max"] : []
}

group "default" {
  targets = ["node", "web"]
}

target "node" {
  context    = "."
  dockerfile = "infra/docker/Dockerfile.node"
  args = {
    APPS = NODE_APPS
  }
  tags       = ["flashdrop/node:${IMAGE_TAG}"]
  cache-from = cache_from("node")
  cache-to   = cache_to("node")
}

target "web" {
  context    = "."
  dockerfile = "infra/docker/Dockerfile.web"
  tags       = ["flashdrop/web:${IMAGE_TAG}"]
  cache-from = cache_from("web")
  cache-to   = cache_to("web")
}
