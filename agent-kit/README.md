# Agent kit

The runtime bundles the generic t3 skill and t3ctl. Each server installs them into its agent skill directories on startup and update. Mesh configuration supplies machine identities, model aliases and personal instructions.

For an offline staging copy use `agent-kit/install.sh --dest DIR`. Fleet installation is handled by mesh bootstrap and rolling updates. See [mesh guidance](../docs/mesh/README.md).
