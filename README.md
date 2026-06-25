wis2gc
======

An open source WIS2 Downloader / Global Cache for WIS2 based on NodeRed

### About

This is the github repository of a WIS2 downloader tool written in Node Red. 
Working along two additional tools aria2 for all downloads and redis/valkey (a key/value pair database) cluster, wis2gc can be used for :
- an internal WIS2 downloader tool 
- an official Global Cache compliant with the features of a WIS2 Global Cache

It is quite versatile in terms of deployment. 
In its simplest form, it can run as a single container running all the required functions (subscriber, downloader, cleaner). It can also run in a multi containers manner on a single host to provide scalability. And last, it is possible to run it on a multi VMs (minimum 6 to ensure a redundant and scalable deployment of redis) environment for a scalable and redundant setup.

You can refer to the documentation in the Documentation folder on how to run and configure the tool.

The github repository contains:
- flows.json : the full implementation of a scalable, redundant WIS2 downloader
- all that is needed to create your own version of the docker container (Dockerfile, flows.json,... )
- in the Documentation folder 
    - explanations on the flows.json file
    - the structure of the configuration.yml file
    - example of compose file to run the docker container