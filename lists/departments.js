const departments = [
  { id: 27, display_name: "Medicine" },
  { id: 33, display_name: "SocialSciences" },
  { id: 22, display_name: "Engineering" },
  { id: 12, display_name: "ArtsandHumanities" },
  { id: 17, display_name: "ComputerScience" },
  { id: 13, display_name: "BiochemistryGeneticsandMolecularBiology" },
  { id: 11, display_name: "AgriculturalandBiologicalSciences" },
  { id: 23, display_name: "EnvironmentalScience" },
  { id: 25, display_name: "MaterialsScience" },
  { id: 31, display_name: "PhysicsandAstronomy" },
  { id: 14, display_name: "BusinessManagementandAccounting" },
  { id: 36, display_name: "HealthProfessions" },
  { id: 20, display_name: "EconomicsEconometricsandFinance" },
  { id: 32, display_name: "Psychology" },
  { id: 16, display_name: "Chemistry" },
  { id: 19, display_name: "EarthandPlanetarySciences" },
  { id: 28, display_name: "Neuroscience" },
  { id: 26, display_name: "Mathematics" },
  { id: 24, display_name: "ImmunologyandMicrobiology" },
  { id: 18, display_name: "DecisionSciences" },
  { id: 21, display_name: "Energy" },
  { id: 29, display_name: "Nursing" },
  { id: 30, display_name: "PharmacologyToxicologyandPharmaceutics" },
  { id: 35, display_name: "Dentistry" },
  { id: 15, display_name: "ChemicalEngineering" },
  { id: 34, display_name: "Veterinary" }
];

const departmentNames = departments.map((department) => department.display_name);

const departmentIdByName = departments.reduce((acc, department) => {
  acc[department.display_name] = department.id;
  return acc;
}, {});

module.exports = {
  departments,
  departmentNames,
  departmentIdByName
};
